import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { env } from "../../src/config/env.js";
import { paymentConfig } from "../../src/config/payment.js";
import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";
import { setBaseTransactionProvider } from "../../services/checkout/checkout.provider.js";

useTestDatabase();

env.TRUST_PROXY_HOPS = 1;
env.RATE_LIMIT_IP_AUTH_MAX = 1;
env.RATE_LIMIT_IP_AUTH_WINDOW_MS = 60_000;
env.RATE_LIMIT_IP_PUBLIC_MAX = 2;
env.RATE_LIMIT_IP_PUBLIC_WINDOW_MS = 60_000;
env.RATE_LIMIT_IP_RPC_MAX = 1;
env.RATE_LIMIT_IP_RPC_WINDOW_MS = 60_000;
env.RATE_LIMIT_MERCHANT_MAX = 1;
env.RATE_LIMIT_MERCHANT_WINDOW_MS = 60_000;

const { createApp } = await import("../../src/app.js");

const app = createApp();

async function signIn(email: string, password: string, ip: string): Promise<string[]> {
  const response = await request(app)
    .post("/api/merchant-sessions")
    .set("X-Forwarded-For", ip)
    .send({ email, password });

  const cookies = response.headers["set-cookie"];
  if (!Array.isArray(cookies)) throw new Error("expected session cookie");
  return cookies;
}

describe("rate limits", () => {
  it("blocks repeated merchant registration from the same IP", async () => {
    const email = `${randomUUID()}@example.com`;

    const first = await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "1.2.3.4")
      .send({ name: "Test", email, password: "SuperSecret123!" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "1.2.3.4")
      .send({
        name: "Test",
        email: `${randomUUID()}@example.com`,
        password: "SuperSecret123!",
      });
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ success: false, error: "Too many requests" });
    expect(second.headers["ratelimit-limit"]).toBe("1");
    expect(second.headers["ratelimit-remaining"]).toBe("0");
    expect(second.headers["ratelimit-reset"]).toBeDefined();
    expect(second.headers["retry-after"]).toBe(String(Math.ceil(60_000 / 1000)));
  });

  it("ignores spoofed left-hand X-Forwarded-For values", async () => {
    const email = `${randomUUID()}@example.com`;
    const first = await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "spoofed-client, 1.2.3.5")
      .send({ name: "Test", email, password: "SuperSecret123!" });
    const second = await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "different-spoof, 1.2.3.5")
      .send({
        name: "Test",
        email: `${randomUUID()}@example.com`,
        password: "SuperSecret123!",
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });

  it("allows distinct IPs to register independently", async () => {
    const first = await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "2.3.4.5")
      .send({
        name: "Test",
        email: `${randomUUID()}@example.com`,
        password: "SuperSecret123!",
      });
    const second = await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "3.4.5.6")
      .send({
        name: "Test",
        email: `${randomUUID()}@example.com`,
        password: "SuperSecret123!",
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it("does not rate limit the health endpoint", async () => {
    for (let i = 0; i < 3; i++) {
      const response = await request(app).get("/api/health").set("X-Forwarded-For", "9.9.9.9");
      expect(response.status).toBe(200);
    }
  });

  it("blocks public reads from the same IP after the budget", async () => {
    const publicId = randomUUID();

    const first = await request(app)
      .get(`/api/payment-links/${publicId}`)
      .set("X-Forwarded-For", "4.5.6.7");
    const second = await request(app)
      .get(`/api/payment-links/${publicId}`)
      .set("X-Forwarded-For", "4.5.6.7");
    const third = await request(app)
      .get(`/api/payment-links/${publicId}`)
      .set("X-Forwarded-For", "4.5.6.7");

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(third.status).toBe(429);
  });

  it("enforces per-merchant limits independently of IP", async () => {
    const email = `${randomUUID()}@example.com`;
    const password = "SuperSecret123!";

    await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "5.6.7.8")
      .send({ name: "Test", email, password });

    const cookies = await signIn(email, password, "5.6.7.9");

    const first = await request(app)
      .post("/api/payment-links")
      .set("Cookie", cookies)
      .set("X-Forwarded-For", "5.6.7.8")
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const second = await request(app)
      .post("/api/payment-links")
      .set("Cookie", cookies)
      .set("X-Forwarded-For", "5.6.7.8")
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
  });

  it("limits two merchants independently when sharing one IP", async () => {
    const emailA = `${randomUUID()}@example.com`;
    const emailB = `${randomUUID()}@example.com`;
    const password = "SuperSecret123!";

    await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "7.7.7.7")
      .send({ name: "A", email: emailA, password });
    await request(app)
      .post("/api/merchants")
      .set("X-Forwarded-For", "7.7.7.8")
      .send({ name: "B", email: emailB, password });

    const cookiesA = await signIn(emailA, password, "7.7.7.9");
    const cookiesB = await signIn(emailB, password, "7.7.7.10");

    env.RATE_LIMIT_IP_PUBLIC_MAX = 10;
    const sharedIp = "8.8.8.8";

    const firstA = await request(app)
      .post("/api/payment-links")
      .set("Cookie", cookiesA)
      .set("X-Forwarded-For", sharedIp)
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const firstB = await request(app)
      .post("/api/payment-links")
      .set("Cookie", cookiesB)
      .set("X-Forwarded-For", sharedIp)
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const secondA = await request(app)
      .post("/api/payment-links")
      .set("Cookie", cookiesA)
      .set("X-Forwarded-For", sharedIp)
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    env.RATE_LIMIT_IP_PUBLIC_MAX = 2;

    expect(firstA.status).toBe(400);
    expect(firstB.status).toBe(400);
    expect(secondA.status).toBe(429);
  });

  it("does not call Base RPC for a rate-limited transaction submission", async () => {
    const merchantId = randomUUID();
    await getDb()
      .insertInto("user")
      .values({
        id: merchantId,
        name: "Test",
        email: `${randomUUID()}@example.com`,
        emailVerified: false,
        image: null,
        receivingWalletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })
      .execute();

    const publicId = randomUUID();
    const now = new Date();
    await getDb()
      .insertInto("paymentIntents")
      .values({
        id: randomUUID(),
        merchantId,
        publicId,
        amountAtomic: "1000000",
        asset: paymentConfig.asset,
        chain: paymentConfig.chain,
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        description: null,
        reference: null,
        status: "awaiting_payment",
        expiresAt: new Date(Date.now() + 60_000),
        payerAddress: null,
        transactionHash: null,
        confirmationCount: 0,
        providerEventId: null,
        paidAt: null,
        reorgDetectedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const getTransaction = vi.fn(() => Promise.resolve(undefined));
    setBaseTransactionProvider({
      getTransaction,
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const first = await request(app)
      .post(`/api/payment-links/${publicId}/transactions`)
      .set("X-Forwarded-For", "6.7.8.9")
      .send({ transactionHash: `0x${"a".repeat(64)}` });
    const second = await request(app)
      .post(`/api/payment-links/${publicId}/transactions`)
      .set("X-Forwarded-For", "6.7.8.9")
      .send({ transactionHash: `0x${"b".repeat(64)}` });

    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });
});
