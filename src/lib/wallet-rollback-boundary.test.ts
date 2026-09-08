import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";

const migrationFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);
const boundaryMigrationName = "20260907020000_guard_wallet_change_rollback";
const alertMigrationName = "20260908010000_add_operational_alert_outbox";
const walletEventTypes = [
  "merchant.receiving_wallet_change_requested",
  "merchant.receiving_wallet_change_cancelled",
  "merchant.receiving_wallet_change_applied",
] as const;

async function createMigratedDatabase(): Promise<{
  db: Kysely<unknown>;
  migrator: Migrator;
}> {
  const pglite = new PGlite();
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite }) });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw new Error("Rollback-boundary test migration failed", { cause: error });
  }
  const alertRollback = await migrator.migrateDown();
  if (alertRollback.error) {
    await db.destroy();
    throw new Error("Alert migration rollback failed", { cause: alertRollback.error });
  }
  if (alertRollback.results?.[0]?.migrationName !== alertMigrationName) {
    await db.destroy();
    throw new Error("Expected alert migration rollback before the wallet boundary test");
  }
  await sql`
    insert into "user" ("id", "name", "email")
    values ('rollback-merchant', 'Rollback Merchant', 'rollback@example.com')
  `.execute(db);
  return { db, migrator };
}

async function readProtectedState(db: Kysely<unknown>) {
  const walletTable = await sql<{ exists: boolean }>`
    select exists (
      select 1 from information_schema.tables
      where table_name = 'walletChangeRequests'
    ) as exists
  `.execute(db);
  const events = await sql<{ eventType: string }>`
    select "eventType" from "auditEvents" order by "eventType"
  `.execute(db);
  const constraints = await sql<{ name: string; definition: string }>`
    select conname as name, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = '"auditEvents"'::regclass
    order by conname
  `.execute(db);
  const boundary = await sql<{ name: string }>`
    select name from "kysely_migration" where name = ${boundaryMigrationName}
  `.execute(db);
  const comment = await sql<{ comment: string | null }>`
    select obj_description('"walletChangeRequests"'::regclass) as comment
  `.execute(db);

  return {
    walletTableExists: walletTable.rows[0]?.exists,
    events: events.rows,
    constraints: constraints.rows,
    boundary: boundary.rows,
    comment: comment.rows[0]?.comment,
  };
}

describe.each(walletEventTypes)("wallet rollback boundary with %s", (eventType) => {
  it("fails before changing schema or audit history", async () => {
    const { db, migrator } = await createMigratedDatabase();
    try {
      await sql`
          insert into "auditEvents" (
            "id", "eventType", "actorType", "actorId", "merchantId",
            "paymentIntentId", "metadata"
          )
          values (
            ${`event-${eventType}`}, ${eventType}, 'merchant', 'rollback-merchant',
            'rollback-merchant', null, '{}'
          )
        `.execute(db);
      const before = await readProtectedState(db);

      const rollback = await migrator.migrateDown();
      expect(rollback.error).toBeInstanceOf(Error);
      expect((rollback.error as Error).message).toContain(
        "keep the forward schema and roll back application code only",
      );

      expect(await readProtectedState(db)).toEqual(before);
    } finally {
      await db.destroy();
    }
  }, 10_000);
});

describe("wallet rollback before the audit boundary", () => {
  it("allows the boundary and wallet migration to roll back when no new events exist", async () => {
    const { db, migrator } = await createMigratedDatabase();
    try {
      const boundaryRollback = await migrator.migrateDown();
      expect(boundaryRollback.error).toBeUndefined();
      expect(boundaryRollback.results).toEqual([
        { migrationName: boundaryMigrationName, direction: "Down", status: "Success" },
      ]);
      const monitoringRollback = await migrator.migrateDown();
      expect(monitoringRollback.error).toBeUndefined();
      expect(monitoringRollback.results?.[0]).toMatchObject({
        migrationName: "20260907010000_add_late_settlement_monitoring",
        direction: "Down",
        status: "Success",
      });
      const walletRollback = await migrator.migrateDown();
      expect(walletRollback.error).toBeUndefined();
      expect(walletRollback.results?.[0]).toMatchObject({
        migrationName: "20260831010000_add_wallet_change_requests",
        direction: "Down",
        status: "Success",
      });

      const walletTable = await sql<{ exists: boolean }>`
          select exists (
            select 1 from information_schema.tables
            where table_name = 'walletChangeRequests'
          ) as exists
        `.execute(db);
      const removedHistory = await sql<{ name: string }>`
          select name from "kysely_migration"
          where name in (
            ${boundaryMigrationName},
            '20260907010000_add_late_settlement_monitoring',
            '20260831010000_add_wallet_change_requests'
          )
        `.execute(db);
      expect(walletTable.rows[0]?.exists).toBe(false);
      expect(removedHistory.rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  }, 10_000);
});
