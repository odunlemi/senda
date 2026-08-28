import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    drop constraint if exists "paymentIntents_status_check"
  `.execute(db);

  await sql`
    alter table "paymentIntents"
    add constraint "paymentIntents_status_check"
    check (
      "status" in (
        'created',
        'awaiting_payment',
        'confirming',
        'paid',
        'expired',
        'failed',
        'dropped'
      )
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    drop constraint if exists "paymentIntents_status_check"
  `.execute(db);

  await sql`
    alter table "paymentIntents"
    add constraint "paymentIntents_status_check"
    check (
      "status" in (
        'created',
        'awaiting_payment',
        'confirming',
        'paid',
        'expired',
        'failed'
      )
    )
  `.execute(db);
}
