import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const duplicates = await sql<{ transactionHash: string }>`
    select lower("transactionHash") as "transactionHash"
    from "paymentIntents"
    where "transactionHash" is not null
    group by lower("transactionHash")
    having count(*) > 1
    limit 1
  `.execute(db);
  if (duplicates.rows[0]) {
    throw new Error(
      `Duplicate transaction hash requires manual reconciliation: ${duplicates.rows[0].transactionHash}`,
    );
  }

  await sql`
    alter table "paymentIntents"
    drop constraint if exists "paymentIntents_transactionHash_key"
  `.execute(db);

  await sql`
    update "paymentIntents"
    set "transactionHash" = lower("transactionHash")
    where "transactionHash" is not null
  `.execute(db);

  await sql`
    create unique index "paymentIntents_transactionHash_lower_idx"
    on "paymentIntents" (lower("transactionHash"))
    where "transactionHash" is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists "paymentIntents_transactionHash_lower_idx"`.execute(db);
  await sql`
    alter table "paymentIntents"
    add constraint "paymentIntents_transactionHash_key" unique ("transactionHash")
  `.execute(db);
}
