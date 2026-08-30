import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  const collisions = await sql<{ address: string }>`
    select lower("receivingWalletAddress") as address
    from "user"
    where "receivingWalletAddress" is not null
    group by lower("receivingWalletAddress")
    having count(*) > 1
  `.execute(db);

  if (collisions.rows.length > 0) {
    throw new Error(
      `Cannot normalize receiving wallet addresses: ${collisions.rows.length} case-insensitive collision(s) found.`,
    );
  }

  await sql`
    update "user"
    set "receivingWalletAddress" = lower("receivingWalletAddress")
    where "receivingWalletAddress" is not null
  `.execute(db);

  await sql`drop index if exists "user_receivingWalletAddress_idx"`.execute(db);

  await sql`
    create unique index "user_receivingWalletAddress_ci_idx"
    on "user" (lower("receivingWalletAddress"))
    where "receivingWalletAddress" is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists "user_receivingWalletAddress_ci_idx"`.execute(db);
  await sql`
    create unique index "user_receivingWalletAddress_idx"
    on "user" ("receivingWalletAddress")
    where "receivingWalletAddress" is not null
  `.execute(db);
}
