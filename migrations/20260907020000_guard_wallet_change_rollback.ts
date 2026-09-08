import type { Kysely } from "kysely";
import { sql } from "kysely";

const rollbackBlockedMessage =
  "Wallet-change audit history exists; keep the forward schema and roll back application code only";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    comment on table "walletChangeRequests" is
    'Rollback boundary: retain this schema after durable wallet-change audit events exist.'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Kysely runs migrations transactionally. This lock prevents a wallet event
  // from being appended between the preflight and removal of the boundary.
  await sql`lock table "auditEvents" in share row exclusive mode`.execute(db);
  const result = await sql<{ eventType: string }>`
    select "eventType"
    from "auditEvents"
    where "eventType" in (
      'merchant.receiving_wallet_change_requested',
      'merchant.receiving_wallet_change_cancelled',
      'merchant.receiving_wallet_change_applied'
    )
    limit 1
  `.execute(db);

  if (result.rows[0]) {
    throw new Error(`${rollbackBlockedMessage}: ${result.rows[0].eventType}`);
  }

  await sql`comment on table "walletChangeRequests" is null`.execute(db);
}
