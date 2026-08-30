import crypto from "node:crypto";

import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";

useTestDatabase();

const { createApp } = await import("../../src/app.js");
const { resetMerchantAuth } = await import("./merchants.config.js");

beforeAll(() => {
  resetMerchantAuth();
});

const app = createApp();

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

  it("records a receiving wallet change as an audit event", async () => {
    const nextWallet = "0xcccccccccccccccccccccccccccccccccccccccc";
    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: nextWallet });

    expect(response.status).toBe(200);

    const merchant = await getDb()
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    const events = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .orderBy("createdAt", "desc")
      .execute();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({
      actorType: "merchant",
      actorId: merchant.id,
      metadata: {
        previousWalletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        newWalletAddress: nextWallet,
      },
    });
  });

  it("does not create an audit event for a no-op wallet update", async () => {
    const previous = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .executeTakeFirstOrThrow();

    const response = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({
        receivingWalletAddress: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      });

    expect(response.status).toBe(200);

    const current = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("eventType", "=", "merchant.receiving_wallet_changed")
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

  it("commits one wallet-change audit event per concurrent different update", async () => {
    const merchant = await getDb()
      .selectFrom("user")
      .select(["id", "receivingWalletAddress"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();

    const before = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .executeTakeFirstOrThrow();

    const walletA = "0xdddddddddddddddddddddddddddddddddddddddd";
    const walletB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    await Promise.all([
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", sessionCookie)
        .send({ receivingWalletAddress: walletA }),
      request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", sessionCookie)
        .send({ receivingWalletAddress: walletB }),
    ]);

    const current = await getDb()
      .selectFrom("user")
      .select("receivingWalletAddress")
      .where("id", "=", merchant.id)
      .executeTakeFirstOrThrow();

    const events = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("merchantId", "=", merchant.id)
      .where("eventType", "=", "merchant.receiving_wallet_changed")
      .orderBy("createdAt", "desc")
      .execute();

    const newCount = events.length - Number(before.count);
    expect(newCount).toBe(2);
    expect([walletA, walletB]).toContain(current.receivingWalletAddress);

    const latestEvent = events[0];
    const priorEvent = events[1];
    if (!latestEvent || !priorEvent) {
      throw new Error("expected two wallet-change audit events");
    }

    const latest = latestEvent.metadata as {
      newWalletAddress: string;
      previousWalletAddress: string;
    };
    const prior = priorEvent.metadata as {
      newWalletAddress: string;
      previousWalletAddress: string;
    };
    expect(latest).toMatchObject({
      newWalletAddress: current.receivingWalletAddress,
      previousWalletAddress: prior.newWalletAddress,
    });
    expect(prior.previousWalletAddress).toBe(merchant.receivingWalletAddress);
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
    const mockRandomUUID = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-0000-0000-000000000001");

    try {
      const merchant = await getDb()
        .selectFrom("user")
        .select(["id", "receivingWalletAddress"])
        .where("email", "=", email)
        .executeTakeFirstOrThrow();

      await getDb()
        .insertInto("auditEvents")
        .values({
          id: crypto.randomUUID(),
          eventType: "merchant.receiving_wallet_changed",
          actorType: "merchant",
          actorId: merchant.id,
          merchantId: merchant.id,
          paymentIntentId: null,
          metadata: { test: true },
        })
        .execute();

      const beforeWallet = merchant.receivingWalletAddress;
      const response = await request(app)
        .put("/api/merchant-wallet")
        .set("Cookie", sessionCookie)
        .send({
          receivingWalletAddress: "0xffffffffffffffffffffffffffffffffffffffff",
        });

      expect(response.status).toBeGreaterThanOrEqual(500);

      const after = await getDb()
        .selectFrom("user")
        .select("receivingWalletAddress")
        .where("id", "=", merchant.id)
        .executeTakeFirstOrThrow();

      expect(after.receivingWalletAddress).toBe(beforeWallet);
    } finally {
      mockRandomUUID.mockRestore();
    }
  });
});
