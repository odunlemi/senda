import crypto from "node:crypto";

import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";
import {
  applyWalletChangeRequest,
  cancelPendingWalletChange,
  setOrRequestMerchantWallet,
} from "../merchants/merchants.service.js";
import { dispatchOperationalAlerts } from "./operational-alerts.dispatcher.js";

useTestDatabase();

const initialAddress = "0x1111111111111111111111111111111111111111";
const requestedAddress = "0x2222222222222222222222222222222222222222";

async function createMerchant(address: string | null = initialAddress): Promise<string> {
  const id = crypto.randomUUID();
  await getDb()
    .insertInto("user")
    .values({
      id,
      name: "Producer Test Merchant",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      receivingWalletAddress: address,
    })
    .execute();
  return id;
}

async function deliveryKinds(merchantId: string): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("operationalAlertDeliveries as delivery")
    .innerJoin("auditEvents as audit", "audit.id", "delivery.auditEventId")
    .select("delivery.eventKind")
    .where("audit.merchantId", "=", merchantId)
    .orderBy("delivery.occurredAt")
    .execute();
  return rows.map((row) => row.eventKind);
}

beforeEach(async () => {
  await sql`delete from "operationalAlertDeliveries"`.execute(getDb());
  await sql`delete from "auditEvents"`.execute(getDb());
  await sql`delete from "walletChangeRequests"`.execute(getDb());
  await sql`delete from "paymentIntents"`.execute(getDb());
  await sql`delete from "user"`.execute(getDb());
});

describe("wallet operational alert producers", () => {
  it("enqueues one request alert and no duplicate for a replay", async () => {
    const merchantId = await createMerchant();
    const first = await setOrRequestMerchantWallet(merchantId, requestedAddress);
    const replay = await setOrRequestMerchantWallet(merchantId, requestedAddress.toUpperCase());

    expect(first.kind).toBe("pending");
    expect(replay.kind).toBe("pending");
    expect(await deliveryKinds(merchantId)).toEqual(["merchant.receiving_wallet_change_requested"]);
  });

  it("enqueues a merchant cancellation with request correlation", async () => {
    const merchantId = await createMerchant();
    const pending = await setOrRequestMerchantWallet(merchantId, requestedAddress);
    if (pending.kind !== "pending") throw new Error("Expected pending request");

    await cancelPendingWalletChange(merchantId);

    expect(await deliveryKinds(merchantId)).toEqual([
      "merchant.receiving_wallet_change_requested",
      "merchant.receiving_wallet_change_cancelled",
    ]);
    const cancelled = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select("payload")
      .where("eventKind", "=", "merchant.receiving_wallet_change_cancelled")
      .executeTakeFirstOrThrow();
    expect(cancelled.payload).toMatchObject({
      subject: {
        merchantId,
        walletChangeRequestId: pending.request.id,
        cancelledBy: "merchant",
      },
    });
  });

  it("enqueues one application alert and skips its compatibility audit event", async () => {
    const merchantId = await createMerchant();
    const pending = await setOrRequestMerchantWallet(merchantId, requestedAddress);
    if (pending.kind !== "pending") throw new Error("Expected pending request");
    await sql`
      update "walletChangeRequests"
      set "requestedAt" = clock_timestamp() - interval '2 seconds',
          "activationAt" = clock_timestamp() - interval '1 second'
      where "id" = ${pending.request.id}
    `.execute(getDb());

    await expect(applyWalletChangeRequest(pending.request.id)).resolves.toMatchObject({
      kind: "applied",
    });
    await expect(applyWalletChangeRequest(pending.request.id)).resolves.toMatchObject({
      kind: "already-terminal",
    });

    expect(await deliveryKinds(merchantId)).toEqual([
      "merchant.receiving_wallet_change_requested",
      "merchant.receiving_wallet_change_applied",
    ]);
    const auditKinds = await getDb()
      .selectFrom("auditEvents")
      .select("eventType")
      .where("merchantId", "=", merchantId)
      .orderBy("createdAt")
      .execute();
    expect(auditKinds.map((row) => row.eventType)).toEqual([
      "merchant.receiving_wallet_change_requested",
      "merchant.receiving_wallet_change_applied",
      "merchant.receiving_wallet_changed",
    ]);
  });

  it("enqueues a system cancellation with its safe reason", async () => {
    const merchantId = await createMerchant();
    const pending = await setOrRequestMerchantWallet(merchantId, requestedAddress);
    if (pending.kind !== "pending") throw new Error("Expected pending request");
    await sql`
      update "walletChangeRequests"
      set "requestedAt" = clock_timestamp() - interval '2 seconds',
          "activationAt" = clock_timestamp() - interval '1 second'
      where "id" = ${pending.request.id}
    `.execute(getDb());
    await getDb()
      .updateTable("user")
      .set({ receivingWalletAddress: "0x3333333333333333333333333333333333333333" })
      .where("id", "=", merchantId)
      .execute();

    await expect(applyWalletChangeRequest(pending.request.id)).resolves.toMatchObject({
      kind: "cancelled",
      reason: "previous_address_changed_before_activation",
    });
    const cancelled = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select("payload")
      .where("eventKind", "=", "merchant.receiving_wallet_change_cancelled")
      .executeTakeFirstOrThrow();
    expect(cancelled.payload).toMatchObject({
      subject: {
        walletChangeRequestId: pending.request.id,
        cancelledBy: "system",
        reason: "previous_address_changed_before_activation",
      },
    });
  });

  it("does not enqueue an alert for initial wallet setup", async () => {
    const merchantId = await createMerchant(null);
    await expect(setOrRequestMerchantWallet(merchantId, initialAddress)).resolves.toMatchObject({
      kind: "immediate",
    });
    expect(await deliveryKinds(merchantId)).toEqual([]);
  });

  it("rolls back the domain request and audit event when enqueue fails", async () => {
    const merchantId = await createMerchant();
    await sql`
      alter table "operationalAlertDeliveries"
      add constraint "test_reject_alert_enqueue" check (false)
    `.execute(getDb());

    try {
      await expect(setOrRequestMerchantWallet(merchantId, requestedAddress)).rejects.toThrow();
    } finally {
      await sql`
        alter table "operationalAlertDeliveries"
        drop constraint "test_reject_alert_enqueue"
      `.execute(getDb());
    }

    const requests = await getDb()
      .selectFrom("walletChangeRequests")
      .select(({ fn }) => fn.count("id").as("count"))
      .where("merchantId", "=", merchantId)
      .executeTakeFirstOrThrow();
    const events = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => fn.count("id").as("count"))
      .where("merchantId", "=", merchantId)
      .executeTakeFirstOrThrow();
    expect(Number(requests.count)).toBe(0);
    expect(Number(events.count)).toBe(0);
  });

  it("keeps a committed domain transition intact when delivery fails", async () => {
    const merchantId = await createMerchant();
    const pending = await setOrRequestMerchantWallet(merchantId, requestedAddress);
    if (pending.kind !== "pending") throw new Error("Expected pending request");

    await expect(
      dispatchOperationalAlerts({
        deliver: () =>
          Promise.resolve({
            outcome: "retryable_failure",
            errorCode: "network_error",
            httpStatus: null,
          }),
      }),
    ).resolves.toMatchObject({ claimed: 1, retried: 1 });

    const request = await getDb()
      .selectFrom("walletChangeRequests")
      .select("status")
      .where("id", "=", pending.request.id)
      .executeTakeFirstOrThrow();
    const audit = await getDb()
      .selectFrom("auditEvents")
      .select("id")
      .where("merchantId", "=", merchantId)
      .where("eventType", "=", "merchant.receiving_wallet_change_requested")
      .executeTakeFirstOrThrow();
    const delivery = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(["status", "attemptCount"])
      .where("auditEventId", "=", audit.id)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe("pending");
    expect(delivery).toEqual({ status: "pending", attemptCount: 1 });
  });
});
