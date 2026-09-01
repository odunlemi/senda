import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "walletChangeRequests" (
      "id" text not null primary key,
      "merchantId" text not null references "user" ("id") on delete cascade,
      "previousAddress" text not null,
      "requestedAddress" text not null,
      "status" text not null check ("status" in ('pending', 'cancelled', 'applied')),
      "requestedAt" timestamptz not null default current_timestamp,
      "activationAt" timestamptz not null,
      "cancelledAt" timestamptz,
      "appliedAt" timestamptz,
      "createdAt" timestamptz not null default current_timestamp,
      "updatedAt" timestamptz not null default current_timestamp,
      constraint "walletChangeRequests_activation_after_request_check"
        check ("activationAt" >= "requestedAt"),
      constraint "walletChangeRequests_terminal_check"
        check (
          (
            "status" = 'pending'
            and "cancelledAt" is null
            and "appliedAt" is null
          )
          or (
            "status" = 'cancelled'
            and "cancelledAt" is not null
            and "appliedAt" is null
          )
          or (
            "status" = 'applied'
            and "appliedAt" is not null
            and "cancelledAt" is null
          )
        ),
      constraint "walletChangeRequests_previous_address_valid_check"
        check (lower("previousAddress") ~ '^0x[a-f0-9]{40}$'),
      constraint "walletChangeRequests_requested_address_valid_check"
        check (lower("requestedAddress") ~ '^0x[a-f0-9]{40}$'),
      constraint "walletChangeRequests_previous_address_lowercase_check"
        check ("previousAddress" = lower("previousAddress")),
      constraint "walletChangeRequests_requested_address_lowercase_check"
        check ("requestedAddress" = lower("requestedAddress")),
      constraint "walletChangeRequests_addresses_distinct_check"
        check (lower("previousAddress") != lower("requestedAddress"))
    )
  `.execute(db);

  await sql`
    create index "walletChangeRequests_merchantId_idx" on "walletChangeRequests" ("merchantId")
  `.execute(db);

  await sql`
    create unique index "walletChangeRequests_merchantId_pending_unique_idx"
    on "walletChangeRequests" ("merchantId")
    where "status" = 'pending'
  `.execute(db);

  await sql`
    create unique index "walletChangeRequests_requestedAddress_ci_pending_unique_idx"
    on "walletChangeRequests" (lower("requestedAddress"))
    where "status" = 'pending'
  `.execute(db);

  await sql`
    create index "walletChangeRequests_activationAt_pending_idx"
    on "walletChangeRequests" ("activationAt")
    where "status" = 'pending'
  `.execute(db);

  await sql`
    alter table "auditEvents"
    drop constraint if exists "auditEvents_eventType_check"
  `.execute(db);
  await sql`
    alter table "auditEvents"
    add constraint "auditEvents_eventType_check"
    check (
      "eventType" in (
        'merchant.receiving_wallet_changed',
        'payment.reorg_detected',
        'merchant.receiving_wallet_change_requested',
        'merchant.receiving_wallet_change_cancelled',
        'merchant.receiving_wallet_change_applied'
      )
    )
  `.execute(db);

  await sql`
    alter table "auditEvents"
    drop constraint if exists "auditEvents_subject_consistent_check"
  `.execute(db);
  await sql`
    alter table "auditEvents"
    add constraint "auditEvents_subject_consistent_check"
    check (
      (
        "eventType" in (
          'merchant.receiving_wallet_changed',
          'merchant.receiving_wallet_change_requested',
          'merchant.receiving_wallet_change_cancelled',
          'merchant.receiving_wallet_change_applied'
        )
        and "merchantId" is not null
      )
      or (
        "eventType" = 'payment.reorg_detected'
        and "merchantId" is not null
        and "paymentIntentId" is not null
      )
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists "walletChangeRequests"`.execute(db);

  await sql`
    alter table "auditEvents"
    drop constraint if exists "auditEvents_eventType_check"
  `.execute(db);
  await sql`
    alter table "auditEvents"
    add constraint "auditEvents_eventType_check"
    check (
      "eventType" in ('merchant.receiving_wallet_changed', 'payment.reorg_detected')
    )
  `.execute(db);

  await sql`
    alter table "auditEvents"
    drop constraint if exists "auditEvents_subject_consistent_check"
  `.execute(db);
  await sql`
    alter table "auditEvents"
    add constraint "auditEvents_subject_consistent_check"
    check (
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
  `.execute(db);
}
