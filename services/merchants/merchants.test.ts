import crypto from "node:crypto";

import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";

import { env } from "../../src/config/env.js";
import { getDb } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import { useTestDatabase } from "../../src/lib/testing.js";

useTestDatabase();

const { createApp } = await import("../../src/app.js");
const { resetMerchantAuth } = await import("./merchants.config.js");
const { applyWalletChangeRequest, cancelPendingWalletChange } =
  await import("./merchants.service.js");
const { processDueWalletChanges } = await import("./merchants.worker.js");

beforeAll(() => {
  resetMerchantAuth();
});

const app = createApp();

function randomAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

function requireSessionCookie(response: request.Response): string {
  const cookies = response.headers["set-cookie"];
  if (!cookies) throw new Error("expected a session cookie");
  return cookies;
}

describe("merchant access", () => {
  const email = `merchant-${Date.now()}@example.com`;
  const password = "SuperSecret123!";
  let sessionCookie: string;

  it("registers a merchant and creates a session", async () => {
    const response = await request(app)
      .post("/api/merchants")
      .send({ name: "Ada Payments", email, password });

    expect(response.status).toBe(201);
    const body = response.body as {
      data: { merchant: { email: string; receivingWalletAddress: string | null } };
    };
    expect(body.data.merchant.email).toBe(email);
    expect(body.data.merchant.receivingWalletAddress).toBeNull();
    sessionCookie = requireSessionCookie(response);
  });

  it("reads the current merchant from the session", async () => {
    const response = await request(app)
      .get("/api/merchant-sessions/current")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(200);
    const body = response.body as {
      data: { merchant: { email: string } };
    };
    expect(body.data.merchant.email).toBe(email);
  });

  it("signs in with email and password", async () => {
    const response = await request(app).post("/api/merchant-sessions").send({ email, password });

    expect(response.status).toBe(201);
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("requires a session to create a payment link", async () => {
    const response = await request(app)
      .post("/api/payment-links")
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(401);
  });

  it("requires the merchant to configure a receiving wallet", async () => {
    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", sessionCookie)
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "Merchant receiving wallet is not configured",
    });
  });

  it("configures one receiving wallet and derives payment destinations from it", async () => {
    const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const walletResponse = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    expect(walletResponse.status).toBe(200);
    const walletBody = walletResponse.body as {
      data: { receivingWalletAddress: string };
    };
    expect(walletBody.data.receivingWalletAddress).toBe(wallet);

    const merchantResponse = await request(app)
      .get("/api/merchant-sessions/current")
      .set("Cookie", sessionCookie);
    const merchantBody = merchantResponse.body as {
      data: { merchant: { receivingWalletAddress: string | null } };
    };
    expect(merchantBody.data.merchant.receivingWalletAddress).toBe(wallet);

    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", sessionCookie)
      .send({
        destinationAddress: "0x1111111111111111111111111111111111111111",
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(201);
    const paymentBody = response.body as {
      data: { paymentIntent: { destinationAddress: string } };
    };
    expect(paymentBody.data.paymentIntent.destinationAddress).toBe(wallet);
  });

  it("records a requested wallet change as an audit event", async () => {
    const nextWallet = "0xcccccccccccccccccccccccccccccccccccccccc";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: nextWallet });

    expect(response.status).toBe(202);

    const body = response.body as {
      data: { requestedAddress: string; previousAddress: string; activationAt: string };
    };
    expect(body.data.requestedAddress).toBe(nextWallet);
    expect(body.data.previousAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    const events = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_change_requested")
      .orderBy("createdAt", "desc")
      .execute();

    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      actorType: "merchant",
      actorId: merchant.id,
      metadata: {
        previousWalletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requestedWalletAddress: nextWallet,
      },
    });

    const active = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", merchant.id)
      .executeTakeFirstOrThrow();
    expect(active.receivingWalletAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("rejects wallet changes with a stale session", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const stale = new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000);
    await sql`update "session" set "createdAt" = ${stale} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );

    const wallet = "0x9999999999999999999999999999999999999999";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    expect(response.status).toBe(403);

    const current = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    expect(current.receivingWalletAddress).not.toBe(wallet);

    await sql`update "session" set "createdAt" = ${new Date()} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );
  });

  it("does not create an audit event for a no-op wallet update", async () => {
    const previous = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("eventType", "=", "merchant.receiving_wallet_change_requested")
      .executeTakeFirstOrThrow();

    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({
        receivingWalletAddress: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      });

    expect(response.status).toBe(202);

    const current = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("eventType", "=", "merchant.receiving_wallet_change_requested")
      .executeTakeFirstOrThrow();

    expect(current.count).toBe(previous.count);
  });

  it("returns 400 for invalid payment-link amounts and expiry", async () => {
    const cases = [
      { amountAtomic: "0", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { amountAtomic: "1000000", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    ];

    for (const body of cases) {
      const response = await request(app)
        .post("/api/payment-links")
        .set("Cookie", sessionCookie)
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it("creates a payment link owned by the signed-in merchant", async () => {
    const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", sessionCookie)
      .send({
        destinationAddress: "0xmerchant",
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        description: "Consulting",
      });

    expect(response.status).toBe(201);
    const body = response.body as {
      data: { paymentIntent: Record<string, unknown> };
    };
    expect(body.data.paymentIntent).toMatchObject({
      destinationAddress: wallet,
      amountAtomic: "1000000",
      asset: "USDC",
      chain: "base",
      approvalRequired: true,
    });
    expect(body.data.paymentIntent).not.toHaveProperty("merchantId");
  });

  it("only allows one pending replacement per merchant", async () => {
    const concurrentEmail = `concurrent-merchant-${Date.now()}@example.com`;
    const register = await request(app)
      .post("/api/merchants")
      .send({ name: "Concurrent Merchant", email: concurrentEmail, password });
    const concurrentCookie = requireSessionCookie(register);

    const wallet = "0x1111111111111111111111111111111111111111";
    const first = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", concurrentCookie)
      .send({ receivingWalletAddress: wallet });
    expect(first.status).toBe(200);

    const walletA = "0xdddddddddddddddddddddddddddddddddddddddd";
    const walletB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    const [responseA, responseB] = await Promise.all([
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", concurrentCookie)
        .send({ receivingWalletAddress: walletA }),
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", concurrentCookie)
        .send({ receivingWalletAddress: walletB }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([202, 409]);

    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", concurrentEmail)
      .executeTakeFirstOrThrow();
    const pending = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("merchantId", "=", merchant.id)
      .where("status", "=", "pending")
      .execute();
    expect(pending.length).toBe(1);
  });

  it("does not create concurrent no-op wallet updates", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select(["id", "receivingWalletAddress"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const wallet = merchant.receivingWalletAddress;
    if (!wallet) throw new Error("expected receiving wallet address to be set");

    const before = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .executeTakeFirstOrThrow();

    await Promise.all([
      request(app).put("/api/merchant-wallet").set("Cookie", sessionCookie).send({
        receivingWalletAddress: wallet,
      }),
      request(app).put("/api/merchant-wallet").set("Cookie", sessionCookie).send({
        receivingWalletAddress: wallet.toUpperCase(),
      }),
    ]);

    const current = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .executeTakeFirstOrThrow();

    expect(current.count).toBe(before.count);
  });

  it("rolls back the wallet update when the audit event insertion fails", async () => {
    const rollbackEmail = `rollback-merchant-${Date.now()}@example.com`;
    const register = await request(app)
      .post("/api/merchants")
      .send({ name: "Rollback Merchant", email: rollbackEmail, password });
    expect(register.status).toBe(201);
    const rollbackCookie = requireSessionCookie(register);

    const merchant = await getDb()
      .selectFrom("user")
      .select(["id", "receivingWalletAddress"])
      .where("email", "=", rollbackEmail)
      .executeTakeFirstOrThrow();

    const mockRandomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockImplementation(() => "00000000-0000-0000-0000-000000000001");

    try {
      await getDb()
        .insertInto("auditEvents")
        .values({
          id: "00000000-0000-0000-0000-000000000001",
          eventType: "merchant.receiving_wallet_changed",
          actorType: "merchant",
          actorId: merchant.id,
          merchantId: merchant.id,
          paymentIntentId: null,
          metadata: { test: true },
        })
        .execute();

      const response = await request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", rollbackCookie)
        .send({
          receivingWalletAddress: "0xffffffffffffffffffffffffffffffffffffffff",
        });

      expect(response.status).toBeGreaterThanOrEqual(500);

      const after = await getDb()
        .selectFrom("user")
        .select("receivingWalletAddress")
        .where("id", "=", merchant.id)
        .executeTakeFirstOrThrow();

      expect(after.receivingWalletAddress).toBeNull();
    } finally {
      mockRandomUUID.mockRestore();
    }
  });
});

describe("fresh session enforcement", () => {
  const email = `fresh-merchant-${Date.now()}@example.com`;
  const password = "SuperSecret123!";
  let sessionCookie: string;

  beforeAll(async () => {
    const register = await request(app)
      .post("/api/merchants")
      .send({ name: "Fresh Merchant", email, password });
    expect(register.status).toBe(201);

    const signIn = await request(app).post("/api/merchant-sessions").send({ email, password });
    expect(signIn.status).toBe(201);
    sessionCookie = requireSessionCookie(signIn);
  });

  it("accepts a wallet change from a fresh session", async () => {
    const wallet = "0x0101010101010101010101010101010101010101";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    expect(response.status).toBe(200);
    expect(
      (response.body as { data: { receivingWalletAddress: string } }).data.receivingWalletAddress,
    ).toBe(wallet);
  });

  it("rejects a wallet change just past the freshness boundary", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const stale = new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000);
    await sql`update "session" set "createdAt" = ${stale} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );

    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({
        receivingWalletAddress: "0x0202020202020202020202020202020202020202",
      });

    expect(response.status).toBe(403);
  });

  it("accepts a wallet change just inside the freshness boundary", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const near = new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS - 1) * 1000);
    await sql`update "session" set "createdAt" = ${near} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );

    const wallet = "0x0303030303030303030303030303030303030303";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    expect(response.status).toBe(202);
    const body = response.body as {
      data: { requestedAddress: string; previousAddress: string };
    };
    expect(body.data.requestedAddress).toBe(wallet);
    expect(body.data.previousAddress).toBe("0x0101010101010101010101010101010101010101");
  });

  it("does not change state or create audit events on a stale attempt", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select(["id", "receivingWalletAddress"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const beforeCount = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .executeTakeFirstOrThrow();

    const stale = new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000);
    await sql`update "session" set "createdAt" = ${stale} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );

    const wallet = "0x0404040404040404040404040404040404040404";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    expect(response.status).toBe(403);

    const after = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", merchant.id)
      .executeTakeFirstOrThrow();
    expect(after.receivingWalletAddress).toBe(merchant.receivingWalletAddress);

    const afterCount = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .executeTakeFirstOrThrow();

    expect(afterCount.count).toBe(beforeCount.count);
  });

  it("allows ordinary session endpoints to use a stale but valid session", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const stale = new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000);
    await sql`update "session" set "createdAt" = ${stale} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );

    const response = await request(app)
      .get("/api/merchant-sessions/current")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(200);
  });

  it("reauthenticates through the sign-in endpoint and retries with a fresh session", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const stale = new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000);
    await sql`update "session" set "createdAt" = ${stale} where "userId" = ${merchant.id}`.execute(
      getDb(),
    );

    const staleResponse = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({
        receivingWalletAddress: "0x0505050505050505050505050505050505050505",
      });
    expect(staleResponse.status).toBe(403);

    const signIn = await request(app).post("/api/merchant-sessions").send({ email, password });
    expect(signIn.status).toBe(201);
    const freshCookie = requireSessionCookie(signIn);

    const cancel = await request(app)
      .delete("/api/merchant-wallet/pending")
      .set("Cookie", freshCookie);
    expect(cancel.status).toBe(200);

    const beforeCount = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_change_requested")
      .executeTakeFirstOrThrow();

    const wallet = "0x0505050505050505050505050505050505050505";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", freshCookie)
      .send({ receivingWalletAddress: wallet });
    expect(response.status).toBe(202);

    const afterCount = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_change_requested")
      .executeTakeFirstOrThrow();

    expect(Number(afterCount.count) - Number(beforeCount.count)).toBe(1);
  });
});

describe("delayed wallet replacement", () => {
  const password = "SuperSecret123!";

  async function freshMerchant(): Promise<{
    email: string;
    cookie: string;
    id: string;
    active: string;
  }> {
    const email = `delayed-merchant-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const register = await request(app)
      .post("/api/merchants")
      .send({ name: "Delayed Merchant", email, password });
    expect(register.status).toBe(201);
    const cookie = requireSessionCookie(register);

    const wallet = randomAddress();
    const setup = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: wallet });
    expect(setup.status).toBe(200);

    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    return { email, cookie, id: merchant.id, active: wallet };
  }

  it("returns 202 with a pending address and activation timestamp", async () => {
    const { cookie, active } = await freshMerchant();
    const requested = randomAddress();

    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    expect(response.status).toBe(202);
    const body = response.body as {
      data: { requestedAddress: string; previousAddress: string; activationAt: string };
    };
    expect(body.data.requestedAddress).toBe(requested);
    expect(body.data.previousAddress).toBe(active);
    expect(new Date(body.data.activationAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps payment links using the active address during the delay", async () => {
    const { cookie, active } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", cookie)
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(201);
    const body = response.body as {
      data: { paymentIntent: { destinationAddress: string } };
    };
    expect(body.data.paymentIntent.destinationAddress).toBe(active);
  });

  it("applies a pending change through the worker", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    const pending = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });
    expect(pending.status).toBe(202);

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow()
    ).id;

    const past = new Date(Date.now() - 5000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${past}, "activationAt" = ${new Date(Date.now() - 1000)} where "id" = ${requestId}`.execute(
      getDb(),
    );

    const applyResult = await applyWalletChangeRequest(requestId);
    expect(applyResult.kind).toBe("applied");

    const active = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(active.receivingWalletAddress).toBe(requested);

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .execute();
    expect(appliedEvents.length).toBe(1);

    const changedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .orderBy("createdAt", "desc")
      .execute();
    expect(changedEvents.length).toBe(2);
    expect(changedEvents[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      metadata: { newWalletAddress: requested },
    });
  });

  it("cancels a pending request", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const response = await request(app)
      .delete("/api/merchant-wallet/pending")
      .set("Cookie", cookie);
    expect(response.status).toBe(200);

    const pending = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("merchantId", "=", id)
      .where("status", "=", "pending")
      .execute();
    expect(pending.length).toBe(0);

    const cancelled = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_cancelled")
      .execute();
    expect(cancelled.length).toBe(1);
  });

  it("rejects cancellation with a stale session", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    await sql`update "session" set "createdAt" = ${new Date(Date.now() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000)} where "userId" = ${id}`.execute(
      getDb(),
    );

    const response = await request(app)
      .delete("/api/merchant-wallet/pending")
      .set("Cookie", cookie);
    expect(response.status).toBe(403);
  });

  it("returns 404 when there is no pending request to read or cancel", async () => {
    const { cookie } = await freshMerchant();

    const read = await request(app).get("/api/merchant-wallet/pending").set("Cookie", cookie);
    expect(read.status).toBe(404);

    const cancel = await request(app).delete("/api/merchant-wallet/pending").set("Cookie", cookie);
    expect(cancel.status).toBe(404);
  });

  it("rejects an address already pending for another merchant", async () => {
    const first = await freshMerchant();
    const requested = randomAddress();
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", first.cookie)
      .send({ receivingWalletAddress: requested });

    const second = await freshMerchant();
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", second.cookie)
      .send({ receivingWalletAddress: requested });

    expect(response.status).toBe(409);
  });

  it("does not apply a request whose previous address changed", async () => {
    const { id, active } = await freshMerchant();
    const requested = randomAddress();

    const requestId = (
      await getDb()
        .insertInto("walletChangeRequests")
        .values({
          id: crypto.randomUUID(),
          merchantId: id,
          previousAddress: active,
          requestedAddress: requested,
          status: "pending",
          requestedAt: new Date(Date.now() - 5000),
          activationAt: new Date(Date.now() - 1000),
          cancelledAt: null,
          appliedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

    await sql`update "user" set "receivingWalletAddress" = ${randomAddress()} where "id" = ${id}`.execute(
      getDb(),
    );

    const applyResult = await applyWalletChangeRequest(requestId);
    expect(applyResult.kind).toBe("cancelled");

    const changeRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(changeRequest.status).toBe("cancelled");
  });

  it("rejects an early activation", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    const pending = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });
    expect(pending.status).toBe(202);

    const changeRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("merchantId", "=", id)
      .executeTakeFirstOrThrow();

    const now = new Date();
    await getDb()
      .updateTable("walletChangeRequests")
      .set({
        requestedAt: new Date(now.getTime() - 5000),
        activationAt: new Date(now.getTime() + 5000),
      })
      .where("id", "=", changeRequest.id)
      .execute();

    const result = await applyWalletChangeRequest(changeRequest.id);
    expect(result.kind).toBe("not-due");
    expect(result.request.status).toBe("pending");

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .execute();
    expect(appliedEvents.length).toBe(0);
  });

  it("applies due requests through the worker and skips future requests", async () => {
    const first = await freshMerchant();
    const firstRequested = randomAddress();
    const firstResponse = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", first.cookie)
      .send({ receivingWalletAddress: firstRequested });
    expect(firstResponse.status).toBe(202);

    const second = await freshMerchant();
    const secondRequested = randomAddress();
    const secondResponse = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", second.cookie)
      .send({ receivingWalletAddress: secondRequested });
    expect(secondResponse.status).toBe(202);

    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const future = new Date(now.getTime() + 5000);

    await getDb()
      .updateTable("walletChangeRequests")
      .set({
        requestedAt: new Date(now.getTime() - 5000),
        activationAt: past,
      })
      .where("requestedAddress", "=", firstRequested)
      .execute();
    await getDb()
      .updateTable("walletChangeRequests")
      .set({
        requestedAt: now,
        activationAt: future,
      })
      .where("requestedAddress", "=", secondRequested)
      .execute();

    await processDueWalletChanges();

    const firstActive = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(firstActive.receivingWalletAddress).toBe(firstRequested);

    const secondActive = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", second.id)
      .executeTakeFirstOrThrow();
    expect(secondActive.receivingWalletAddress).not.toBe(secondRequested);

    const secondPending = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("requestedAddress", "=", secondRequested)
      .executeTakeFirstOrThrow();
    expect(secondPending.status).toBe("pending");
  });

  it("is idempotent across repeated activations", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${requestId}`.execute(
      getDb(),
    );

    const first = await applyWalletChangeRequest(requestId);
    expect(first.kind).toBe("applied");

    const second = await applyWalletChangeRequest(requestId);
    expect(second.kind).toBe("already-terminal");
    expect(second.request.status).toBe("applied");

    const changedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .execute();
    expect(changedEvents.length).toBe(2);
  });

  it("cancels activation when the requested address becomes unavailable", async () => {
    const first = await freshMerchant();
    const second = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", second.cookie)
      .send({ receivingWalletAddress: requested });
    const secondRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("merchantId", "=", second.id)
      .executeTakeFirstOrThrow();

    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${new Date(Date.now() - 1000)} where "id" = ${secondRequest.id}`.execute(
      getDb(),
    );

    await sql`update "user" set "receivingWalletAddress" = ${requested} where "id" = ${first.id}`.execute(
      getDb(),
    );

    const result = await applyWalletChangeRequest(secondRequest.id);
    expect(result.kind).toBe("cancelled");

    const cancelledEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", second.id)
      .where("eventType", "=", "merchant.receiving_wallet_change_cancelled")
      .execute();
    expect(cancelledEvents.length).toBe(1);
  });

  it("prevents first-time setup from claiming an address already pending elsewhere", async () => {
    const first = await freshMerchant();
    const pendingAddress = randomAddress();
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", first.cookie)
      .send({ receivingWalletAddress: pendingAddress });

    const email = `unsetup-${Date.now()}@example.com`;
    const register = await request(app)
      .post("/api/merchants")
      .send({ name: "Unsetup Merchant", email, password: "SuperSecret123!" });
    const cookie = requireSessionCookie(register);

    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: pendingAddress });
    expect(response.status).toBe(409);
  });

  it("lets exactly one worker apply a due request when called concurrently", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${requestId}`.execute(
      getDb(),
    );

    const [first, second] = await Promise.all([
      applyWalletChangeRequest(requestId),
      applyWalletChangeRequest(requestId),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["already-terminal", "applied"]);

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .execute();
    expect(appliedEvents.length).toBe(1);

    const changedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .execute();
    expect(changedEvents.length).toBe(2);
  });

  it("serializes first-time setup and a competing reservation for the same address", async () => {
    const address = randomAddress();
    const firstEmail = `first-${Date.now()}-1@example.com`;
    const secondEmail = `second-${Date.now()}-2@example.com`;
    const password = "SuperSecret123!";

    const firstRegister = await request(app)
      .post("/api/merchants")
      .send({ name: "First", email: firstEmail, password });
    const secondRegister = await request(app)
      .post("/api/merchants")
      .send({ name: "Second", email: secondEmail, password });

    const firstCookie = requireSessionCookie(firstRegister);
    const secondCookie = requireSessionCookie(secondRegister);

    const [first, second] = await Promise.all([
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", firstCookie)
        .send({ receivingWalletAddress: address }),
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", secondCookie)
        .send({ receivingWalletAddress: address }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });

  it("applies one due request when the worker runs concurrently", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${requestId}`.execute(
      getDb(),
    );

    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await Promise.all([processDueWalletChanges(), processDueWalletChanges()]);

    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();

    const active = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(active.receivingWalletAddress).toBe(requested);

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .execute();
    expect(appliedEvents.length).toBe(1);

    const changedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .execute();
    expect(changedEvents.length).toBe(2);
  });

  it("races cancellation against activation and reaches one terminal state", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const changeRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("merchantId", "=", id)
      .executeTakeFirstOrThrow();

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${changeRequest.id}`.execute(
      getDb(),
    );

    const [activate, cancel] = await Promise.allSettled([
      applyWalletChangeRequest(changeRequest.id),
      cancelPendingWalletChange(id),
    ]);

    const afterRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", changeRequest.id)
      .executeTakeFirstOrThrow();
    expect(["applied", "cancelled"]).toContain(afterRequest.status);

    const appliedCount = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .executeTakeFirstOrThrow();
    const cancelledCount = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_cancelled")
      .executeTakeFirstOrThrow();

    expect(Number(appliedCount.count) + Number(cancelledCount.count)).toBe(1);

    const fulfilledActivate =
      activate.status === "fulfilled" ? (activate.value as { kind: string }).kind : null;
    const fulfilledCancel =
      cancel.status === "fulfilled" ? (cancel.value as { status: string }).status : null;

    if (afterRequest.status === "applied") {
      expect(fulfilledActivate).toBe("applied");
    } else {
      expect(fulfilledActivate === "already-terminal" || activate.status === "rejected").toBe(true);
      expect(fulfilledCancel).toBe("cancelled");
    }
  });

  it("leaves a future request pending and then applies it on a later worker pass", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();
    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const future = new Date(Date.now() + 60_000);
    await getDb()
      .updateTable("walletChangeRequests")
      .set({ activationAt: future })
      .where("id", "=", requestId)
      .execute();

    await processDueWalletChanges();

    let afterRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(afterRequest.status).toBe("pending");

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${requestId}`.execute(
      getDb(),
    );

    await processDueWalletChanges();

    afterRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(afterRequest.status).toBe("applied");

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .execute();
    expect(appliedEvents.length).toBe(1);
  });

  it("races a pending replacement against first-time setup for the same address", async () => {
    const first = await freshMerchant();
    const address = randomAddress();

    const secondEmail = `race-second-${Date.now()}@example.com`;
    const secondRegister = await request(app)
      .post("/api/merchants")
      .send({ name: "Race Second", email: secondEmail, password });
    const secondCookie = requireSessionCookie(secondRegister);
    const secondId = (secondRegister.body as { data: { merchant: { id: string } } }).data.merchant
      .id;

    const [firstResponse, secondResponse] = await Promise.all([
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", first.cookie)
        .send({ receivingWalletAddress: address }),
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", secondCookie)
        .send({ receivingWalletAddress: address }),
    ]);

    expect([firstResponse.status, secondResponse.status]).toContain(409);
    const success = firstResponse.status !== 409 ? firstResponse : secondResponse;
    expect(success.status === 200 || success.status === 202).toBe(true);

    const active = await getDb()
      .selectFrom("user")
      .select(["id", "receivingWalletAddress"])
      .where("receivingWalletAddress", "=", address)
      .executeTakeFirst();
    const pending = await getDb()
      .selectFrom("walletChangeRequests")
      .select("merchantId")
      .where("requestedAddress", "=", address)
      .where("status", "=", "pending")
      .execute();

    expect((active ? 1 : 0) + pending.length).toBe(1);
    if (active) {
      expect([first.id, secondId]).toContain(active.id);
    } else {
      expect([first.id, secondId]).toContain(pending[0]?.merchantId);
    }
  });

  it("rolls back a replacement request when the audit event insertion fails", async () => {
    const { cookie, id, active } = await freshMerchant();
    const requested = randomAddress();
    const requestId = "00000000-0000-0000-0000-000000000021";
    const duplicateAuditId = "00000000-0000-0000-0000-000000000020";

    await getDb()
      .insertInto("auditEvents")
      .values({
        id: duplicateAuditId,
        eventType: "payment.reorg_detected",
        actorType: "system",
        actorId: null,
        merchantId: id,
        paymentIntentId: "00000000-0000-0000-0000-000000000022",
        metadata: { test: true },
      })
      .execute();

    const beforeRequestCount = await getDb()
      .selectFrom("walletChangeRequests")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();

    const mock = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(requestId)
      .mockReturnValueOnce(duplicateAuditId);

    try {
      const response = await request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", cookie)
        .send({ receivingWalletAddress: requested });
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      mock.mockRestore();
    }

    const afterActive = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(afterActive.receivingWalletAddress).toBe(active);

    const afterRequestCount = await getDb()
      .selectFrom("walletChangeRequests")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    expect(afterRequestCount.count).toBe(beforeRequestCount.count);
  });

  it("rolls back a cancellation when the audit event insertion fails", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const duplicateAuditId = "00000000-0000-0000-0000-000000000030";

    await getDb()
      .insertInto("auditEvents")
      .values({
        id: duplicateAuditId,
        eventType: "payment.reorg_detected",
        actorType: "system",
        actorId: null,
        merchantId: id,
        paymentIntentId: "00000000-0000-0000-0000-000000000031",
        metadata: { test: true },
      })
      .execute();

    const mock = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(duplicateAuditId);

    try {
      const response = await request(app)
        .delete("/api/merchant-wallet/pending")
        .set("Cookie", cookie);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      mock.mockRestore();
    }

    const changeRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(changeRequest.status).toBe("pending");

    const cancelledEvents = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_cancelled")
      .executeTakeFirstOrThrow();
    expect(cancelledEvents.count).toBe(0);
  });

  it("rolls back an application when the audit event insertion fails", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${requestId}`.execute(
      getDb(),
    );

    const duplicateAuditId = "00000000-0000-0000-0000-000000000040";

    await getDb()
      .insertInto("auditEvents")
      .values({
        id: duplicateAuditId,
        eventType: "payment.reorg_detected",
        actorType: "system",
        actorId: null,
        merchantId: id,
        paymentIntentId: "00000000-0000-0000-0000-000000000041",
        metadata: { test: true },
      })
      .execute();

    const mock = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(duplicateAuditId);

    try {
      await expect(applyWalletChangeRequest(requestId)).rejects.toThrow();
    } finally {
      mock.mockRestore();
    }

    const active = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(active.receivingWalletAddress).not.toBe(requested);

    const changeRequest = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(changeRequest.status).toBe("pending");

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .executeTakeFirstOrThrow();
    expect(appliedEvents.count).toBe(0);
  });

  it("retries a due request after an unexpected worker failure", async () => {
    const { cookie, id } = await freshMerchant();
    const requested = randomAddress();

    await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", cookie)
      .send({ receivingWalletAddress: requested });

    const requestId = (
      await getDb()
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", id)
        .executeTakeFirstOrThrow()
    ).id;

    const past = new Date(Date.now() - 1000);
    await sql`update "walletChangeRequests" set "requestedAt" = ${new Date(Date.now() - 5000)}, "activationAt" = ${past} where "id" = ${requestId}`.execute(
      getDb(),
    );
    await sql`update "walletChangeRequests" set "activationAt" = ${new Date(Date.now() + 24 * 60 * 60 * 1000)} where "id" != ${requestId} and "status" = 'pending'`.execute(
      getDb(),
    );

    let calls = 0;
    const real = applyWalletChangeRequest;
    const processor = vi.fn(async (reqId: string) => {
      calls++;
      if (calls === 1) throw new Error("forced worker failure");
      return real(reqId);
    });
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await processDueWalletChanges(processor);

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);

    const stillPending = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(stillPending.status).toBe("pending");

    await processDueWalletChanges(processor);

    expect(calls).toBe(2);

    const applied = await getDb()
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(applied.status).toBe("applied");

    const appliedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_change_applied")
      .execute();
    expect(appliedEvents.length).toBe(1);

    const changedEvents = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .execute();
    expect(changedEvents.length).toBe(2);

    errorLog.mockRestore();
  });
});
