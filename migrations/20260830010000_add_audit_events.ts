import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "auditEvents" (
      "id" text not null primary key,
      "eventType" text not null check (
        "eventType" in ('merchant.receiving_wallet_changed', 'payment.reorg_detected')
      ),
      "actorType" text not null check ("actorType" in ('merchant', 'system')),
      "actorId" text,
      "merchantId" text,
      "paymentIntentId" text,
      "metadata" jsonb not null default '{}',
      "createdAt" timestamptz not null default current_timestamp,
      constraint "auditEvents_actor_consistent_check" check (
        ("actorType" = 'merchant' and "actorId" is not null)
        or ("actorType" = 'system' and "actorId" is null)
      ),
      constraint "auditEvents_subject_consistent_check" check (
        (
          "eventType" = 'merchant.receiving_wallet_changed'
          and "merchantId" is not null
        )
        or (
          "eventType" = 'payment.reorg_detected'
          and "merchantId" is not null
          and "paymentIntentId" is not null
        )
      )
    )
  `.execute(db);

  await sql`create index "auditEvents_merchantId_createdAt_idx" on "auditEvents" ("merchantId", "createdAt")`.execute(
    db,
  );
  await sql`create index "auditEvents_paymentIntentId_createdAt_idx" on "auditEvents" ("paymentIntentId", "createdAt")`.execute(
    db,
  );
  await sql`create index "auditEvents_eventType_createdAt_idx" on "auditEvents" ("eventType", "createdAt")`.execute(
    db,
  );
  await sql`
    create unique index "auditEvents_payment_reorg_unique_idx"
    on "auditEvents" ("paymentIntentId")
    where "eventType" = 'payment.reorg_detected'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists "auditEvents"`.execute(db);
}
