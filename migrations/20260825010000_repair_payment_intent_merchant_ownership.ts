import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    drop constraint if exists "paymentIntents_merchantId_fkey"
  `.execute(db);

  await sql`
    insert into "user" ("id", "name", "email")
    select distinct pi."merchantId", 'Legacy merchant',
      'legacy-' || md5(pi."merchantId") || '@senda.invalid'
    from "paymentIntents" pi
    left join "user" u on u."id" = pi."merchantId"
    where u."id" is null
    on conflict ("id") do nothing
  `.execute(db);

  await sql`
    alter table "paymentIntents"
    add constraint "paymentIntents_merchantId_fkey"
    foreign key ("merchantId") references "user" ("id") on delete restrict
  `.execute(db);
}

// This is a data-preservation migration. Rolling it back must not delete
// placeholder merchants that may now own payment history.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`select 1`.execute(db);
}
