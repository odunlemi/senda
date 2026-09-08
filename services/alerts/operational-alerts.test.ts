import crypto from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationalAlertPayload } from "../../contracts/operational-alerts.js";
import { env } from "../../src/config/env.js";
import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";
import { recordAuditEvent } from "../audit/audit-events.service.js";
import {
  claimOperationalAlerts,
  dispatchOperationalAlerts,
  replayOperationalAlert,
  startOperationalAlertWorker,
} from "./operational-alerts.dispatcher.js";
import {
  createWebhookOperationalAlertAdapter,
  type OperationalAlertDeliveryAdapter,
} from "./operational-alerts.provider.js";

useTestDatabase();

const originalDispatcherConfig = {
  batchSize: env.OPERATIONAL_ALERT_BATCH_SIZE,
  leaseMs: env.OPERATIONAL_ALERT_LEASE_MS,
  maxAttempts: env.OPERATIONAL_ALERT_MAX_ATTEMPTS,
  retryBaseMs: env.OPERATIONAL_ALERT_RETRY_BASE_MS,
  retryMaxMs: env.OPERATIONAL_ALERT_RETRY_MAX_MS,
};

async function createMerchant(): Promise<string> {
  const id = crypto.randomUUID();
  await getDb()
    .insertInto("user")
    .values({
      id,
      name: "Alert Test Merchant",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      receivingWalletAddress: "0x1111111111111111111111111111111111111111",
    })
    .execute();
  return id;
}

async function insertRequestedAlert(merchantId: string): Promise<string> {
  const walletChangeRequestId = crypto.randomUUID();
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const now = await getDatabaseTime(trx);
      await recordAuditEvent(trx, {
        eventType: "merchant.receiving_wallet_change_requested",
        actorType: "merchant",
        actorId: merchantId,
        merchantId,
        paymentIntentId: null,
        metadata: {},
        createdAt: now,
        operationalAlert: {
          eventKind: "merchant.receiving_wallet_change_requested",
          merchantId,
          walletChangeRequestId,
        },
      });
      const delivery = await trx
        .selectFrom("operationalAlertDeliveries")
        .select("id")
        .where("eventKind", "=", "merchant.receiving_wallet_change_requested")
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow();
      return delivery.id;
    });
}

const acceptedAdapter: OperationalAlertDeliveryAdapter = {
  deliver: () => Promise.resolve({ outcome: "accepted", httpStatus: 204 }),
};

beforeEach(async () => {
  env.OPERATIONAL_ALERT_BATCH_SIZE = 20;
  env.OPERATIONAL_ALERT_LEASE_MS = 60_000;
  env.OPERATIONAL_ALERT_MAX_ATTEMPTS = 3;
  env.OPERATIONAL_ALERT_RETRY_BASE_MS = 1_000;
  env.OPERATIONAL_ALERT_RETRY_MAX_MS = 4_000;
  await sql`delete from "operationalAlertDeliveries"`.execute(getDb());
  await sql`delete from "auditEvents"`.execute(getDb());
  await sql`delete from "walletChangeRequests"`.execute(getDb());
  await sql`delete from "paymentIntents"`.execute(getDb());
  await sql`delete from "user"`.execute(getDb());
});

afterAll(() => {
  env.OPERATIONAL_ALERT_BATCH_SIZE = originalDispatcherConfig.batchSize;
  env.OPERATIONAL_ALERT_LEASE_MS = originalDispatcherConfig.leaseMs;
  env.OPERATIONAL_ALERT_MAX_ATTEMPTS = originalDispatcherConfig.maxAttempts;
  env.OPERATIONAL_ALERT_RETRY_BASE_MS = originalDispatcherConfig.retryBaseMs;
  env.OPERATIONAL_ALERT_RETRY_MAX_MS = originalDispatcherConfig.retryMaxMs;
});

describe("operational alert outbox", () => {
  it("persists a strict versioned payload with stable safe identifiers", async () => {
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const row = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .selectAll()
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();

    expect(row).toMatchObject({
      id: deliveryId,
      eventKind: "merchant.receiving_wallet_change_requested",
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
    });
    expect(row.payload).toEqual({
      version: 1,
      deliveryId,
      eventTime: row.occurredAt.toISOString(),
      eventKind: "merchant.receiving_wallet_change_requested",
      subject: {
        merchantId,
        walletChangeRequestId: expect.any(String) as string,
      },
    });
    expect(JSON.stringify(row.payload)).not.toMatch(/password|cookie|token|walletAddress/i);
  });

  it("recovers an abandoned claim and resends the same delivery identifier", async () => {
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const abandoned = await claimOperationalAlerts({
      batchSize: 1,
      leaseMs: 60_000,
      maxAttempts: 3,
    });
    expect(abandoned.deliveries.map((row) => row.id)).toEqual([deliveryId]);
    expect(abandoned.exhausted).toBe(0);
    const abandonedDelivery = abandoned.deliveries[0];
    if (!abandonedDelivery) throw new Error("Expected a claimed delivery");
    const received: string[] = [];
    const receiver: OperationalAlertDeliveryAdapter = {
      deliver: (payload) => {
        received.push(payload.deliveryId);
        return Promise.resolve({ outcome: "accepted", httpStatus: 202 });
      },
    };

    // The receiver accepts the first send, then the worker disappears before
    // it can acknowledge the row in the database.
    await receiver.deliver(abandonedDelivery.payload);

    await sql`
      update "operationalAlertDeliveries"
      set "lastAttemptAt" = clock_timestamp() - interval '2 seconds',
          "leasedUntil" = clock_timestamp() - interval '1 second'
      where "id" = ${deliveryId}
    `.execute(getDb());

    const summary = await dispatchOperationalAlerts(receiver);

    expect(received).toEqual([deliveryId, deliveryId]);
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    const row = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(["status", "attemptCount"])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "delivered", attemptCount: 2 });
  });

  it("uses capped backoff and reaches a durable exhausted state", async () => {
    env.OPERATIONAL_ALERT_MAX_ATTEMPTS = 5;
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const retryingAdapter: OperationalAlertDeliveryAdapter = {
      deliver: () =>
        Promise.resolve({
          outcome: "retryable_failure",
          errorCode: "network_error",
          httpStatus: null,
        }),
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const summary = await dispatchOperationalAlerts(retryingAdapter);
      expect(summary.claimed).toBe(1);
      const row = await getDb()
        .selectFrom("operationalAlertDeliveries")
        .select(["status", "attemptCount", "nextAttemptAt", "lastAttemptAt", "failedAt"])
        .where("id", "=", deliveryId)
        .executeTakeFirstOrThrow();
      expect(row.attemptCount).toBe(attempt);

      if (attempt < 5) {
        expect(row.status).toBe("pending");
        const scheduledDelay = row.nextAttemptAt!.getTime() - row.lastAttemptAt!.getTime();
        const expectedDelay = Math.min(1_000 * 2 ** (attempt - 1), 4_000);
        expect(scheduledDelay).toBeGreaterThanOrEqual(expectedDelay);
        expect(scheduledDelay).toBeLessThan(expectedDelay + 250);
        await sql`
          update "operationalAlertDeliveries"
          set "nextAttemptAt" = clock_timestamp() - interval '1 second'
          where "id" = ${deliveryId}
        `.execute(getDb());
      } else {
        expect(row.status).toBe("exhausted");
        expect(row.nextAttemptAt).toBeNull();
        expect(row.failedAt).not.toBeNull();
      }
    }
  });

  it("exhausts an expired final lease without sending beyond the attempt limit", async () => {
    env.OPERATIONAL_ALERT_MAX_ATTEMPTS = 1;
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const { deliveries } = await claimOperationalAlerts({
      batchSize: 1,
      leaseMs: 60_000,
      maxAttempts: 1,
    });
    const [claimed] = deliveries;
    expect(claimed?.attemptCount).toBe(1);

    await sql`
      update "operationalAlertDeliveries"
      set "lastAttemptAt" = clock_timestamp() - interval '2 seconds',
          "leasedUntil" = clock_timestamp() - interval '1 second'
      where "id" = ${deliveryId}
    `.execute(getDb());
    let deliveryCalls = 0;

    const summary = await dispatchOperationalAlerts({
      deliver: () => {
        deliveryCalls += 1;
        return Promise.resolve({ outcome: "accepted", httpStatus: 204 });
      },
    });

    expect(summary).toMatchObject({ claimed: 0, exhausted: 1 });
    expect(deliveryCalls).toBe(0);
    await expect(
      getDb()
        .selectFrom("operationalAlertDeliveries")
        .select(["status", "attemptCount", "failedAt", "lastErrorCode"])
        .where("id", "=", deliveryId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "exhausted",
      attemptCount: 1,
      failedAt: expect.any(Date) as Date,
      lastErrorCode: "lease_expired_after_max_attempts",
    });
  });

  it("replays an exhausted delivery with its original identity and payload", async () => {
    env.OPERATIONAL_ALERT_MAX_ATTEMPTS = 1;
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const retryingAdapter: OperationalAlertDeliveryAdapter = {
      deliver: () =>
        Promise.resolve({
          outcome: "retryable_failure",
          errorCode: "network_error",
          httpStatus: null,
        }),
    };

    await expect(dispatchOperationalAlerts(retryingAdapter)).resolves.toMatchObject({
      claimed: 1,
      exhausted: 1,
    });
    const beforeReplay = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(["id", "payload", "status", "attemptCount"])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(beforeReplay).toMatchObject({ status: "exhausted", attemptCount: 1 });

    await expect(replayOperationalAlert(deliveryId)).resolves.toBe(true);
    await expect(dispatchOperationalAlerts(acceptedAdapter)).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
    });

    const delivered = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(["id", "payload", "status", "attemptCount"])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(delivered).toEqual({
      id: beforeReplay.id,
      payload: beforeReplay.payload,
      status: "delivered",
      attemptCount: 1,
    });
  });

  it("exhausts pending work made ineligible by a lower attempt limit", async () => {
    env.OPERATIONAL_ALERT_MAX_ATTEMPTS = 3;
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
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

    env.OPERATIONAL_ALERT_MAX_ATTEMPTS = 1;
    await expect(dispatchOperationalAlerts(acceptedAdapter)).resolves.toMatchObject({
      claimed: 0,
      exhausted: 1,
    });
    await expect(
      getDb()
        .selectFrom("operationalAlertDeliveries")
        .select(["status", "attemptCount", "nextAttemptAt", "failedAt", "lastErrorCode"])
        .where("id", "=", deliveryId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "exhausted",
      attemptCount: 1,
      nextAttemptAt: null,
      failedAt: expect.any(Date) as Date,
      lastErrorCode: "attempt_limit_reached",
    });
  });

  it("isolates an invalid poison payload from another due delivery", async () => {
    const merchantId = await createMerchant();
    const poisonId = await insertRequestedAlert(merchantId);
    const healthyId = await insertRequestedAlert(merchantId);
    await sql`
      update "operationalAlertDeliveries" set "payload" = "payload" - 'subject'
      where "id" = ${poisonId}
    `.execute(getDb());

    const summary = await dispatchOperationalAlerts(acceptedAdapter);
    expect(summary).toMatchObject({ claimed: 2, delivered: 1, failed: 1 });

    const rows = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(["id", "status", "lastErrorCode"])
      .orderBy("id")
      .execute();
    expect(rows.find((row) => row.id === poisonId)).toMatchObject({
      status: "failed",
      lastErrorCode: "invalid_payload",
    });
    expect(rows.find((row) => row.id === healthyId)).toMatchObject({ status: "delivered" });
  });

  it("leaves the backlog untouched when worker delivery is disabled", async () => {
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const previousMode = env.OPERATIONAL_ALERTS_MODE;
    env.OPERATIONAL_ALERTS_MODE = "disabled";
    try {
      const stop = startOperationalAlertWorker();
      stop();
    } finally {
      env.OPERATIONAL_ALERTS_MODE = previousMode;
    }

    const row = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(["status", "attemptCount"])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "pending", attemptCount: 0 });
  });

  it("starts an enabled worker, delivers immediately, and can be stopped", async () => {
    const merchantId = await createMerchant();
    const deliveryId = await insertRequestedAlert(merchantId);
    const previousConfig = {
      mode: env.OPERATIONAL_ALERTS_MODE,
      url: env.OPERATIONAL_ALERT_WEBHOOK_URL,
      token: env.OPERATIONAL_ALERT_WEBHOOK_TOKEN,
      intervalMs: env.OPERATIONAL_ALERT_DISPATCH_INTERVAL_MS,
      timeoutMs: env.OPERATIONAL_ALERT_TIMEOUT_MS,
    };
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    let stop: () => void = () => undefined;
    try {
      env.OPERATIONAL_ALERTS_MODE = "webhook";
      env.OPERATIONAL_ALERT_WEBHOOK_URL = "https://controlled-receiver.example.test/events";
      env.OPERATIONAL_ALERT_WEBHOOK_TOKEN = "controlled-test-token";
      env.OPERATIONAL_ALERT_DISPATCH_INTERVAL_MS = 60_000;
      env.OPERATIONAL_ALERT_TIMEOUT_MS = 1_000;
      globalThis.fetch = () => {
        requestCount += 1;
        return Promise.resolve(new Response(null, { status: 202 }));
      };

      stop = startOperationalAlertWorker();
      await vi.waitFor(
        async () => {
          const delivery = await getDb()
            .selectFrom("operationalAlertDeliveries")
            .select("status")
            .where("id", "=", deliveryId)
            .executeTakeFirstOrThrow();
          expect(delivery.status).toBe("delivered");
        },
        { timeout: 2_000, interval: 20 },
      );
      expect(requestCount).toBe(1);
    } finally {
      stop();
      globalThis.fetch = originalFetch;
      env.OPERATIONAL_ALERTS_MODE = previousConfig.mode;
      env.OPERATIONAL_ALERT_WEBHOOK_URL = previousConfig.url;
      env.OPERATIONAL_ALERT_WEBHOOK_TOKEN = previousConfig.token;
      env.OPERATIONAL_ALERT_DISPATCH_INTERVAL_MS = previousConfig.intervalMs;
      env.OPERATIONAL_ALERT_TIMEOUT_MS = previousConfig.timeoutMs;
    }
  });
});

describe("authenticated operational webhook", () => {
  it("delivers to a controlled receiver with authentication and deduplication headers", async () => {
    const requests: {
      authorization: string | undefined;
      idempotencyKey: string | undefined;
      eventKind: string | undefined;
      body: unknown;
    }[] = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (_input, init) => {
        const headers = new Headers(init?.headers);
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
        requests.push({
          authorization: headers.get("authorization") ?? undefined,
          idempotencyKey: headers.get("idempotency-key") ?? undefined,
          eventKind: headers.get("x-senda-event") ?? undefined,
          body: JSON.parse(init.body) as unknown,
        });
        return Promise.resolve(new Response(null, { status: 202 }));
      };
      const merchantId = await createMerchant();
      const deliveryId = await insertRequestedAlert(merchantId);
      const adapter = createWebhookOperationalAlertAdapter({
        url: "https://controlled-receiver.example.test/operator-alerts",
        bearerToken: "controlled-test-token",
        timeoutMs: 1_000,
      });

      await expect(dispatchOperationalAlerts(adapter)).resolves.toMatchObject({
        claimed: 1,
        delivered: 1,
      });
      const delivery = await getDb()
        .selectFrom("operationalAlertDeliveries")
        .select(["status", "payload"])
        .where("id", "=", deliveryId)
        .executeTakeFirstOrThrow();
      expect(delivery.status).toBe("delivered");
      expect(requests).toEqual([
        {
          authorization: "Bearer controlled-test-token",
          idempotencyKey: deliveryId,
          eventKind: "merchant.receiving_wallet_change_requested",
          body: delivery.payload,
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies retryable and permanent HTTP responses", async () => {
    const payload: OperationalAlertPayload = {
      version: 1,
      deliveryId: crypto.randomUUID(),
      eventTime: new Date().toISOString(),
      eventKind: "merchant.receiving_wallet_change_requested",
      subject: {
        merchantId: crypto.randomUUID(),
        walletChangeRequestId: crypto.randomUUID(),
      },
    };
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => Promise.resolve(new Response(null, { status: 503 }));
      const adapter = createWebhookOperationalAlertAdapter({
        url: "https://alerts.example.test/events",
        bearerToken: "controlled-test-token",
        timeoutMs: 1_000,
      });
      await expect(adapter.deliver(payload)).resolves.toMatchObject({
        outcome: "retryable_failure",
        httpStatus: 503,
      });

      globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));
      await expect(adapter.deliver(payload)).resolves.toMatchObject({
        outcome: "permanent_failure",
        httpStatus: 401,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts a webhook request at the configured finite timeout", async () => {
    const payload: OperationalAlertPayload = {
      version: 1,
      deliveryId: crypto.randomUUID(),
      eventTime: new Date().toISOString(),
      eventKind: "merchant.receiving_wallet_change_requested",
      subject: {
        merchantId: crypto.randomUUID(),
        walletChangeRequestId: crypto.randomUUID(),
      },
    };
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = avertNeverCompletingRequest;
      const adapter = createWebhookOperationalAlertAdapter({
        url: "https://alerts.example.test/events",
        bearerToken: "controlled-test-token",
        timeoutMs: 10,
      });
      await expect(adapter.deliver(payload)).resolves.toEqual({
        outcome: "retryable_failure",
        errorCode: "timeout",
        httpStatus: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function avertNeverCompletingRequest(
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("Expected a timeout signal"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        const timeoutError = new Error("Webhook request timed out");
        timeoutError.name = "TimeoutError";
        reject(timeoutError);
      },
      { once: true },
    );
  });
}
