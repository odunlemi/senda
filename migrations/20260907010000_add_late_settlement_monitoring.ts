import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table "paymentIntents"
    add column "submittedAt" timestamptz,
    add column "monitoringExpiresAt" timestamptz,
    add column "monitoringEscalatedAt" timestamptz
  `.execute(db);

  // Existing unresolved hashes receive a fresh monitoring window at deploy so
  // the migration itself cannot silently strand a potentially valid payment.
  await sql`
    update "paymentIntents"
    set
      "submittedAt" = coalesce("paidAt", "updatedAt", "createdAt"),
      "monitoringExpiresAt" = case
        when "status" in ('confirming', 'dropped') then clock_timestamp() + interval '24 hours'
        else coalesce("paidAt", "updatedAt", "createdAt") + interval '24 hours'
      end
    where "transactionHash" is not null
  `.execute(db);

  await sql`
    alter table "paymentIntents"
    add constraint "paymentIntents_submission_monitoring_check"
    check (
      (
        "transactionHash" is null
        and "submittedAt" is null
        and "monitoringExpiresAt" is null
        and "monitoringEscalatedAt" is null
      )
      or (
        "transactionHash" is not null
        and "submittedAt" is not null
        and "monitoringExpiresAt" is not null
        and "monitoringExpiresAt" >= "submittedAt"
        and (
          "monitoringEscalatedAt" is null
          or "monitoringEscalatedAt" >= "monitoringExpiresAt"
        )
      )
    )
  `.execute(db);

  await sql`
    create index "paymentIntents_unresolved_monitoring_idx"
    on "paymentIntents" ("monitoringExpiresAt")
    where "status" in ('confirming', 'dropped') and "monitoringEscalatedAt" is null
  `.execute(db);

  await sql`
    create function "preventPaymentMonitoringTimelineChange"()
    returns trigger
    language plpgsql
    as $$
    begin
      if old."submittedAt" is not null and new."submittedAt" is distinct from old."submittedAt" then
        raise exception 'payment submission time is immutable';
      end if;
      if old."monitoringExpiresAt" is not null
        and new."monitoringExpiresAt" is distinct from old."monitoringExpiresAt" then
        raise exception 'payment monitoring deadline is immutable';
      end if;
      return new;
    end;
    $$
  `.execute(db);

  await sql`
    create trigger "paymentIntents_monitoring_timeline_immutable"
    before update on "paymentIntents"
    for each row execute function "preventPaymentMonitoringTimelineChange"()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists "paymentIntents_monitoring_timeline_immutable" on "paymentIntents"
  `.execute(db);
  await sql`drop function if exists "preventPaymentMonitoringTimelineChange"()`.execute(db);
  await sql`drop index if exists "paymentIntents_unresolved_monitoring_idx"`.execute(db);
  await sql`
    alter table "paymentIntents"
    drop constraint if exists "paymentIntents_submission_monitoring_check"
  `.execute(db);
  await sql`
    alter table "paymentIntents"
    drop column if exists "monitoringEscalatedAt",
    drop column if exists "monitoringExpiresAt",
    drop column if exists "submittedAt"
  `.execute(db);
}
