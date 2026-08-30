import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update "paymentIntents"
    set "paidAt" = "updatedAt"
    where "status" = 'paid'
      and "paidAt" is null
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No safe reversal for backfilled timestamps.
}
