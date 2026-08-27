import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { up as repairPaymentIntentMerchantOwnership } from "../../migrations/20260825010000_repair_payment_intent_merchant_ownership.js";
import { up as normalizeTransactionHashes } from "../../migrations/20260825020000_normalize_transaction_hashes.js";

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
