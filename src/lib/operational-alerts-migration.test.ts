import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  down as removeOperationalAlertOutbox,
  up as addOperationalAlertOutbox,
} from "../../migrations/20260908010000_add_operational_alert_outbox.js";

async function createAuditDatabase(): Promise<Kysely<unknown>> {
  const pglite = new PGlite();
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite }) });
  await sql`
    create table "auditEvents" (
      "id" text not null primary key,
      "eventType" text not null,
      "createdAt" timestamptz not null default current_timestamp
    )
  `.execute(db);
  return db;
}

describe("operational alert outbox migration", () => {
  it("starts at an empty cutover and enforces delivery state and identity", async () => {
    const db = await createAuditDatabase();
    try {
      await sql`
        insert into "auditEvents" ("id", "eventType")
        values ('historical-event', 'merchant.receiving_wallet_change_requested')
      `.execute(db);
      await addOperationalAlertOutbox(db);

      const cutover = await sql<{ count: string }>`
        select count(*)::text as count from "operationalAlertDeliveries"
      `.execute(db);
      expect(cutover.rows[0]?.count).toBe("0");

      const indexes = await sql<{ indexname: string; indexdef: string }>`
        select indexname, indexdef from pg_indexes
        where tablename = 'operationalAlertDeliveries'
        order by indexname
      `.execute(db);
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          "operationalAlertDeliveries_auditEvent_unique",
          "operationalAlertDeliveries_due_idx",
          "operationalAlertDeliveries_expired_lease_idx",
          "operationalAlertDeliveries_pkey",
        ]),
      );
      const indexDefinitions = Object.fromEntries(
        indexes.rows.map((row) => [row.indexname, row.indexdef]),
      );
      expect(indexDefinitions.operationalAlertDeliveries_due_idx).toContain('"nextAttemptAt"');
      expect(indexDefinitions.operationalAlertDeliveries_due_idx).toContain(
        "WHERE (status = 'pending'::text)",
      );
      expect(indexDefinitions.operationalAlertDeliveries_expired_lease_idx).toContain(
        '"leasedUntil"',
      );
      expect(indexDefinitions.operationalAlertDeliveries_expired_lease_idx).toContain(
        "WHERE (status = 'processing'::text)",
      );

      await sql`
        insert into "operationalAlertDeliveries" (
          "id", "auditEventId", "eventKind", "payloadVersion", "payload",
          "occurredAt", "status", "nextAttemptAt"
        ) values (
          'delivery-1', 'historical-event',
          'merchant.receiving_wallet_change_requested', 1,
          jsonb_build_object(
            'version', 1,
            'deliveryId', 'delivery-1',
            'eventKind', 'merchant.receiving_wallet_change_requested'
          ),
          clock_timestamp(), 'pending', clock_timestamp()
        )
      `.execute(db);

      await expect(
        sql`
          insert into "operationalAlertDeliveries" (
            "id", "auditEventId", "eventKind", "payloadVersion", "payload",
            "occurredAt", "status", "nextAttemptAt"
          ) values (
            'delivery-2', 'historical-event',
            'merchant.receiving_wallet_change_requested', 1,
            jsonb_build_object(
              'version', 1,
              'deliveryId', 'delivery-2',
              'eventKind', 'merchant.receiving_wallet_change_requested'
            ),
            clock_timestamp(), 'pending', clock_timestamp()
          )
        `.execute(db),
      ).rejects.toThrow();

      await expect(
        sql`
          update "operationalAlertDeliveries"
          set "payload" = jsonb_set("payload", '{deliveryId}', '"other"')
          where "id" = 'delivery-1'
        `.execute(db),
      ).rejects.toThrow();

      await expect(
        sql`
          update "operationalAlertDeliveries"
          set "status" = 'delivered', "nextAttemptAt" = null
          where "id" = 'delivery-1'
        `.execute(db),
      ).rejects.toThrow();

      await expect(
        db
          .transaction()
          .execute(async (trx) => removeOperationalAlertOutbox(trx as unknown as Kysely<unknown>)),
      ).rejects.toThrow("Operational alert history exists");
      const preserved = await sql<{ deliveries: string; audits: string }>`
        select
          (select count(*)::text from "operationalAlertDeliveries") as deliveries,
          (select count(*)::text from "auditEvents") as audits
      `.execute(db);
      expect(preserved.rows[0]).toEqual({ deliveries: "1", audits: "1" });
    } finally {
      await db.destroy();
    }
  });

  it("allows an empty outbox to roll back", async () => {
    const db = await createAuditDatabase();
    try {
      await addOperationalAlertOutbox(db);
      await expect(
        db
          .transaction()
          .execute(async (trx) => removeOperationalAlertOutbox(trx as unknown as Kysely<unknown>)),
      ).resolves.toBeUndefined();
      const table = await sql<{ exists: boolean }>`
        select exists (
          select 1 from information_schema.tables
          where table_name = 'operationalAlertDeliveries'
        ) as exists
      `.execute(db);
      expect(table.rows[0]?.exists).toBe(false);
    } finally {
      await db.destroy();
    }
  });
});
