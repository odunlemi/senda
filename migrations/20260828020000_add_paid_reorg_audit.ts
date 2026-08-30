import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    add column "paidAt" timestamptz,
    add column "reorgDetectedAt" timestamptz
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    drop column if exists "paidAt",
    drop column if exists "reorgDetectedAt"
  `.execute(db);
}
