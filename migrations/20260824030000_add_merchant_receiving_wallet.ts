import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "user"
    add column "receivingWalletAddress" text
  `.execute(db);

  await sql`
    create unique index "user_receivingWalletAddress_idx"
    on "user" ("receivingWalletAddress")
    where "receivingWalletAddress" is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists "user_receivingWalletAddress_idx"`.execute(db);
  await sql`alter table "user" drop column if exists "receivingWalletAddress"`.execute(db);
}
