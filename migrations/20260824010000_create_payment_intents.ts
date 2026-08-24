import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "paymentIntents" (
      "id" text not null primary key,
      "merchantId" text not null,
      "publicId" text not null unique,
      "amountAtomic" text not null check ("amountAtomic" ~ '^[0-9]+$'),
      "asset" text not null check ("asset" = 'USDC'),
      "chain" text not null check ("chain" = 'base'),
      "destinationAddress" text not null,
      "description" text,
      "reference" text,
      "status" text not null default 'created' check (
        "status" in ('created', 'awaiting_payment', 'confirming', 'paid', 'expired', 'failed')
      ),
      "expiresAt" timestamptz not null,
      "payerAddress" text,
      "transactionHash" text unique,
      "confirmationCount" integer not null default 0 check ("confirmationCount" >= 0),
      "providerEventId" text unique,
      "createdAt" timestamptz default current_timestamp not null,
      "updatedAt" timestamptz default current_timestamp not null
    )
  `.execute(db);

  await sql`create index "paymentIntents_merchantId_idx" on "paymentIntents" ("merchantId")`.execute(
    db,
  );
  await sql`create index "paymentIntents_status_idx" on "paymentIntents" ("status")`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists "paymentIntents"`.execute(db);
}
