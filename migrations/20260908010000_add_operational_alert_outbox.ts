import type { Kysely } from "kysely";
import { sql } from "kysely";

const rollbackError =
  "Operational alert history exists; retain the outbox schema and use a forward repair";

export async function up(db: Kysely<unknown>): Promise<void> {
  // This table intentionally starts empty. Audit events created before this
  // migration are the explicit cutover boundary and are not delivered.
  await sql`
    create table "operationalAlertDeliveries" (
      "id" text not null primary key,
      "auditEventId" text not null references "auditEvents" ("id") on delete restrict,
      "eventKind" text not null check (
        "eventKind" in (
          'merchant.receiving_wallet_change_requested',
          'merchant.receiving_wallet_change_cancelled',
          'merchant.receiving_wallet_change_applied',
          'payment.reorg_detected'
        )
      ),
      "payloadVersion" smallint not null check ("payloadVersion" = 1),
      "payload" jsonb not null,
      "occurredAt" timestamptz not null,
      "status" text not null default 'pending' check (
        "status" in ('pending', 'processing', 'delivered', 'failed', 'exhausted')
      ),
      "attemptCount" integer not null default 0 check ("attemptCount" >= 0),
      "nextAttemptAt" timestamptz,
      "leaseToken" text,
      "leasedUntil" timestamptz,
      "lastAttemptAt" timestamptz,
      "deliveredAt" timestamptz,
      "failedAt" timestamptz,
      "lastErrorCode" text,
      "lastHttpStatus" integer check (
        "lastHttpStatus" is null or "lastHttpStatus" between 100 and 599
      ),
      "createdAt" timestamptz not null default current_timestamp,
      "updatedAt" timestamptz not null default current_timestamp,
      constraint "operationalAlertDeliveries_auditEvent_unique" unique ("auditEventId"),
      constraint "operationalAlertDeliveries_payload_consistent_check" check (
        jsonb_typeof("payload") = 'object'
        and "payload" ? 'deliveryId'
        and "payload" ->> 'deliveryId' = "id"
        and "payload" ? 'version'
        and "payload" ->> 'version' = "payloadVersion"::text
        and "payload" ? 'eventKind'
        and "payload" ->> 'eventKind' = "eventKind"
      ),
      constraint "operationalAlertDeliveries_state_consistent_check" check (
        (
          "status" = 'pending'
          and "nextAttemptAt" is not null
          and "leaseToken" is null
          and "leasedUntil" is null
          and "deliveredAt" is null
          and "failedAt" is null
          and (
            ("attemptCount" = 0 and "lastAttemptAt" is null)
            or ("attemptCount" > 0 and "lastAttemptAt" is not null)
          )
        )
        or (
          "status" = 'processing'
          and "attemptCount" > 0
          and "nextAttemptAt" is null
          and "leaseToken" is not null
          and "leasedUntil" is not null
          and "lastAttemptAt" is not null
          and "leasedUntil" > "lastAttemptAt"
          and "deliveredAt" is null
          and "failedAt" is null
        )
        or (
          "status" = 'delivered'
          and "attemptCount" > 0
          and "nextAttemptAt" is null
          and "leaseToken" is null
          and "leasedUntil" is null
          and "lastAttemptAt" is not null
          and "deliveredAt" is not null
          and "deliveredAt" >= "lastAttemptAt"
          and "failedAt" is null
        )
        or (
          "status" in ('failed', 'exhausted')
          and "attemptCount" > 0
          and "nextAttemptAt" is null
          and "leaseToken" is null
          and "leasedUntil" is null
          and "lastAttemptAt" is not null
          and "deliveredAt" is null
          and "failedAt" is not null
          and "failedAt" >= "lastAttemptAt"
        )
      )
    )
  `.execute(db);

  await sql`
    create index "operationalAlertDeliveries_due_idx"
    on "operationalAlertDeliveries" ("nextAttemptAt", "id")
    where "status" = 'pending'
  `.execute(db);

  await sql`
    create index "operationalAlertDeliveries_expired_lease_idx"
    on "operationalAlertDeliveries" ("leasedUntil", "id")
    where "status" = 'processing'
  `.execute(db);

  await sql`
    comment on table "operationalAlertDeliveries" is
      'Cutover starts at migration application; pre-existing audit events are not backfilled.'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`lock table "operationalAlertDeliveries" in share row exclusive mode`.execute(db);
  const existing = await sql<{ exists: boolean }>`
    select exists(select 1 from "operationalAlertDeliveries") as exists
  `.execute(db);

  if (existing.rows[0]?.exists) {
    throw new Error(rollbackError);
  }

  await sql`drop table "operationalAlertDeliveries"`.execute(db);
}
