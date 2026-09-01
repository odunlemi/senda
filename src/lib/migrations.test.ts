import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { up as repairPaymentIntentMerchantOwnership } from "../../migrations/20260825010000_repair_payment_intent_merchant_ownership.js";
import { up as normalizeTransactionHashes } from "../../migrations/20260825020000_normalize_transaction_hashes.js";
import { up as backfillPaidAt } from "../../migrations/20260828030000_backfill_paid_at.js";
import { up as normalizeReceivingWalletAddresses } from "../../migrations/20260830020000_normalize_receiving_wallet_addresses.js";
import { up as addWalletChangeRequests } from "../../migrations/20260831010000_add_wallet_change_requests.js";

describe("payment-intent merchant ownership migration", () => {
  let pglite: PGlite;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    pglite = new PGlite();
    db = new Kysely({ dialect: new PGliteDialect({ pglite }) });

    await sql`
      create table "user" (
        "id" text not null primary key,
        "name" text not null,
        "email" text not null unique
      )
    `.execute(db);
    await sql`
      create table "paymentIntents" (
        "id" text not null primary key,
        "merchantId" text not null
      )
    `.execute(db);
    await sql`
      insert into "paymentIntents" ("id", "merchantId")
      values ('intent-1', 'legacy-merchant')
    `.execute(db);

    await repairPaymentIntentMerchantOwnership(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("backfills a placeholder merchant without discarding payment intents", async () => {
    const merchant = await sql<{ id: string; email: string }>`
      select "id", "email" from "user" where "id" = 'legacy-merchant'
    `.execute(db);
    const paymentIntent = await sql<{ id: string }>`
      select "id" from "paymentIntents" where "id" = 'intent-1'
    `.execute(db);

    expect(merchant.rows[0]?.id).toBe("legacy-merchant");
    expect(merchant.rows[0]?.email).toMatch(/^legacy-.+@senda\.invalid$/);
    expect(paymentIntent.rows[0]).toEqual({ id: "intent-1" });
  });

  it("restores the merchant foreign key", async () => {
    await expect(
      sql`
        insert into "paymentIntents" ("id", "merchantId")
        values ('intent-2', 'missing-merchant')
      `.execute(db),
    ).rejects.toThrow();
  });
});

describe("transaction hash normalization migration", () => {
  let pglite: PGlite;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    pglite = new PGlite();
    db = new Kysely({ dialect: new PGliteDialect({ pglite }) });
    await sql`
      create table "paymentIntents" (
        "id" text not null primary key,
        "transactionHash" text,
        constraint "paymentIntents_transactionHash_key" unique ("transactionHash")
      )
    `.execute(db);
    await sql`
      insert into "paymentIntents" ("id", "transactionHash")
      values ('intent-1', ${`0x${"A".repeat(64)}`})
    `.execute(db);
    await normalizeTransactionHashes(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("stores normalized hashes and enforces case-insensitive uniqueness", async () => {
    const result = await sql<{ transactionHash: string }>`
      select "transactionHash" from "paymentIntents" where "id" = 'intent-1'
    `.execute(db);
    expect(result.rows[0]?.transactionHash).toBe(`0x${"a".repeat(64)}`);

    await expect(
      sql`
        insert into "paymentIntents" ("id", "transactionHash")
        values ('intent-2', ${`0x${"A".repeat(64)}`})
      `.execute(db),
    ).rejects.toThrow();
  });
});

describe("paidAt backfill migration", () => {
  let pglite: PGlite;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    pglite = new PGlite();
    db = new Kysely({ dialect: new PGliteDialect({ pglite }) });

    await sql`
      create table "paymentIntents" (
        "id" text not null primary key,
        "status" text not null,
        "paidAt" timestamptz,
        "updatedAt" timestamptz not null
      )
    `.execute(db);

    const updatedAt = new Date("2026-08-01T00:00:00.000Z");
    await sql`
      insert into "paymentIntents" ("id", "status", "updatedAt")
      values ('paid-1', 'paid', ${updatedAt.toISOString()})
    `.execute(db);

    await backfillPaidAt(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("backfills paidAt from updatedAt for existing paid rows", async () => {
    const result = await sql<{ paidAt: Date; updatedAt: Date }>`
      select "paidAt", "updatedAt" from "paymentIntents" where "id" = 'paid-1'
    `.execute(db);
    expect(result.rows[0]?.paidAt).toEqual(result.rows[0]?.updatedAt);
  });
});

describe("receiving wallet address normalization migration", () => {
  let pglite: PGlite;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    pglite = new PGlite();
    db = new Kysely({ dialect: new PGliteDialect({ pglite }) });

    await sql`
      create table "user" (
        "id" text not null primary key,
        "name" text not null,
        "email" text not null unique,
        "receivingWalletAddress" text
      )
    `.execute(db);
    await sql`
      insert into "user" ("id", "name", "email", "receivingWalletAddress")
      values
        ('merchant-1', 'One', 'one@example.com', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        ('merchant-2', 'Two', 'two@example.com', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    `.execute(db);
    await normalizeReceivingWalletAddresses(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("normalizes safe receiving addresses to lowercase", async () => {
    const result = await sql<{ receivingWalletAddress: string }>`
      select "receivingWalletAddress" from "user" where "id" = 'merchant-1'
    `.execute(db);
    expect(result.rows[0]?.receivingWalletAddress).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("rejects a case-insensitive collision without deleting data", async () => {
    const collisionDb = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
    await sql`
      create table "user" (
        "id" text not null primary key,
        "name" text not null,
        "email" text not null unique,
        "receivingWalletAddress" text
      )
    `.execute(collisionDb);
    await sql`
      insert into "user" ("id", "name", "email", "receivingWalletAddress")
      values
        ('merchant-1', 'One', 'one@example.com', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        ('merchant-2', 'Two', 'two@example.com', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    `.execute(collisionDb);

    await expect(normalizeReceivingWalletAddresses(collisionDb)).rejects.toThrow();

    const remaining = await sql<{ id: string }>`
      select "id" from "user" order by "id"
    `.execute(collisionDb);
    expect(remaining.rows.map((r) => r.id)).toEqual(["merchant-1", "merchant-2"]);

    await collisionDb.destroy();
  });

  it("rejects a differently-cased duplicate after the index is installed", async () => {
    await expect(
      sql`
        insert into "user" ("id", "name", "email", "receivingWalletAddress")
        values ('merchant-3', 'Three', 'three@example.com', '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
      `.execute(db),
    ).rejects.toThrow();
  });
});

describe("wallet change requests migration", () => {
  let pglite: PGlite;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    pglite = new PGlite();
    db = new Kysely({ dialect: new PGliteDialect({ pglite }) });

    await sql`
      create table "user" (
        "id" text not null primary key,
        "name" text not null,
        "email" text not null unique,
        "receivingWalletAddress" text
      )
    `.execute(db);

    await sql`
      create table "auditEvents" (
        "id" text not null primary key,
        "eventType" text not null,
        "actorType" text not null,
        "actorId" text,
        "merchantId" text,
        "paymentIntentId" text,
        "metadata" jsonb,
        "createdAt" timestamptz not null default current_timestamp
      )
    `.execute(db);

    await sql`
      insert into "user" ("id", "name", "email")
      values ('merchant-1', 'One', 'one@example.com'),
        ('merchant-2', 'Two', 'two@example.com')
    `.execute(db);

    await addWalletChangeRequests(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("requires activationAt to be on or after requestedAt", async () => {
    const past = new Date(Date.now() - 1000);
    const furtherPast = new Date(Date.now() - 2000);
    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-1', 'merchant-1', '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222', 'pending',
          ${past}, ${furtherPast}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("rejects invalid or non-distinct previous and requested addresses", async () => {
    const now = new Date();
    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-2', 'merchant-1', 'invalid', '0x2222222222222222222222222222222222222222',
          'pending', ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-3', 'merchant-1', '0x2222222222222222222222222222222222222222',
          '0x2222222222222222222222222222222222222222',
          'pending', ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("enforces one pending request per merchant", async () => {
    const now = new Date();
    await sql`
      insert into "walletChangeRequests" (
        "id", "merchantId", "previousAddress", "requestedAddress", "status",
        "requestedAt", "activationAt", "cancelledAt", "appliedAt"
      )
      values (
        'req-4', 'merchant-1', '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222', 'pending',
        ${now}, ${now}, null, null
      )
    `.execute(db);

    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-5', 'merchant-1', '0x1111111111111111111111111111111111111111',
          '0x3333333333333333333333333333333333333333', 'pending',
          ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("enforces one pending request per address", async () => {
    const now = new Date();
    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-6', 'merchant-2', '0x1111111111111111111111111111111111111111',
          '0x2222222222222222222222222222222222222222', 'pending',
          ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("requires terminal timestamps to match the status", async () => {
    const now = new Date();
    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-7', 'merchant-2', '0x1111111111111111111111111111111111111111',
          '0x3333333333333333333333333333333333333333', 'cancelled',
          ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-8', 'merchant-2', '0x1111111111111111111111111111111111111111',
          '0x3333333333333333333333333333333333333333', 'applied',
          ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("cascades request rows when the merchant is deleted", async () => {
    await sql`delete from "user" where "id" = 'merchant-1'`.execute(db);

    const remaining = await sql<{ id: string }>`
      select "id" from "walletChangeRequests" where "merchantId" = 'merchant-1'
    `.execute(db);
    expect(remaining.rows.length).toBe(0);
  });

  it("rejects mixed-case request addresses", async () => {
    const now = new Date();
    await expect(
      sql`
        insert into "walletChangeRequests" (
          "id", "merchantId", "previousAddress", "requestedAddress", "status",
          "requestedAt", "activationAt", "cancelledAt", "appliedAt"
        )
        values (
          'req-9', 'merchant-2', '0x1111111111111111111111111111111111111111',
          '0x222222222222222222222222222222222222222A', 'pending',
          ${now}, ${now}, null, null
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("creates the partial due-work index on activationAt for pending rows", async () => {
    const result = await sql<{ indexname: string; indexdef: string }>`
      select "indexname", "indexdef" from pg_indexes
      where "tablename" = 'walletChangeRequests'
    `.execute(db);
    const index = result.rows.find(
      (r) => r.indexname === "walletChangeRequests_activationAt_pending_idx",
    );
    expect(index).toBeDefined();
    expect(index?.indexdef).toContain("activationAt");
    expect(index?.indexdef.toLowerCase()).toContain("where");
    expect(index?.indexdef.toLowerCase()).toContain("status");
    expect(index?.indexdef.toLowerCase()).toContain("pending");
  });
});
