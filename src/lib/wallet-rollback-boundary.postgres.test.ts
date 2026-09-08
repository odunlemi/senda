import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString =
  process.env.POSTGRES_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/senda";
const schema = `rollback_boundary_${crypto.randomBytes(8).toString("hex")}`;
const migrationApplicationName = `senda-rollback-migration-${process.pid}`;
const writerApplicationName = `senda-rollback-writer-${process.pid}`;
const migrationFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);
const boundaryMigrationName = "20260907020000_guard_wallet_change_rollback";

let adminPool: Pool;
let migrationPool: Pool;
let writerPool: Pool;
let controlPool: Pool;
let database: Kysely<unknown>;
let migrator: Migrator;
let adminPoolReady = false;
let migrationPoolReady = false;
let writerPoolReady = false;
let controlPoolReady = false;
let databaseReady = false;
let schemaCreated = false;
let setupComplete = false;

async function waitForLock(appName: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  do {
    const result = await adminPool.query<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
         where application_name = $1 and wait_event_type = 'Lock' and state = 'active'
       ) as waiting`,
      [appName],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Expected PostgreSQL lock waiter for ${appName}`);
}

async function insertWalletEvent(client: PoolClient): Promise<void> {
  await client.query(
    `insert into "auditEvents" (
       "id", "eventType", "actorType", "actorId", "merchantId",
       "paymentIntentId", "metadata"
     ) values ($1, 'merchant.receiving_wallet_change_requested', 'merchant',
       'rollback-merchant', 'rollback-merchant', null, '{}')`,
    [crypto.randomUUID()],
  );
}

async function boundaryIsApplied(): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1 from "kysely_migration" where name = ${boundaryMigrationName}
    ) as exists
  `.execute(database);
  return result.rows[0]?.exists ?? false;
}

beforeAll(async () => {
  adminPool = new Pool({ connectionString, max: 2 });
  adminPoolReady = true;
  await adminPool.query(`create schema "${schema}"`);
  schemaCreated = true;

  const options = `-c search_path=${schema},public -c lock_timeout=7000 -c statement_timeout=12000`;
  migrationPool = new Pool({
    connectionString,
    max: 4,
    application_name: migrationApplicationName,
    options,
  });
  migrationPoolReady = true;
  writerPool = new Pool({
    connectionString,
    max: 2,
    application_name: writerApplicationName,
    options,
  });
  writerPoolReady = true;
  controlPool = new Pool({
    connectionString,
    max: 2,
    application_name: `senda-rollback-control-${process.pid}`,
    options,
  });
  controlPoolReady = true;
  database = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) });
  databaseReady = true;
  migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw new Error("Rollback concurrency migrations failed", { cause: error });
  setupComplete = true;
});

beforeEach(async () => {
  const { error } = await migrator.migrateToLatest();
  if (error) throw new Error("Could not restore rollback boundary", { cause: error });
  await sql`delete from "auditEvents"`.execute(database);
  await sql`delete from "paymentIntents"`.execute(database);
  await sql`delete from "walletChangeRequests"`.execute(database);
  await sql`delete from "user"`.execute(database);
  await sql`
    insert into "user" ("id", "name", "email")
    values ('rollback-merchant', 'Rollback Merchant', 'rollback-pg@example.com')
  `.execute(database);
});

afterAll(async () => {
  const errors: unknown[] = [];
  const closes: (() => Promise<unknown>)[] = [];
  if (databaseReady) closes.push(async () => database.destroy());
  else if (migrationPoolReady) closes.push(async () => migrationPool.end());
  if (writerPoolReady) closes.push(async () => writerPool.end());
  if (controlPoolReady) closes.push(async () => controlPool.end());
  if (schemaCreated && adminPoolReady) {
    closes.push(async () => adminPool.query(`drop schema if exists "${schema}" cascade`));
  }
  if (adminPoolReady) closes.push(async () => adminPool.end());

  for (const close of closes) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (setupComplete && errors.length > 0) {
    throw new AggregateError(errors, "Rollback concurrency cleanup failed");
  }
});

describe("wallet rollback boundary concurrency", () => {
  it("observes an audit event whose writer commits before rollback", async () => {
    const writer = await writerPool.connect();
    try {
      await writer.query("begin");
      await insertWalletEvent(writer);

      const rollback = migrator.migrateDown();
      await waitForLock(migrationApplicationName);
      await writer.query("commit");

      const result = await rollback;
      expect(result.error).toBeInstanceOf(Error);
      expect(await boundaryIsApplied()).toBe(true);
      const events = await sql<{ count: string }>`
        select count(*)::text as count from "auditEvents"
      `.execute(database);
      expect(events.rows[0]?.count).toBe("1");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      writer.release();
    }
  });

  it("blocks an audit writer until rollback removes the boundary history", async () => {
    const gate = await controlPool.connect();
    const writer = await writerPool.connect();
    try {
      await gate.query("begin");
      await gate.query('lock table "walletChangeRequests" in access exclusive mode');

      const rollback = migrator.migrateDown();
      await waitForLock(migrationApplicationName);

      await writer.query("begin");
      const insert = insertWalletEvent(writer);
      await waitForLock(writerApplicationName);

      await gate.query("commit");
      const result = await rollback;
      expect(result.error).toBeUndefined();
      expect(await boundaryIsApplied()).toBe(false);

      await insert;
      await writer.query("commit");
      const events = await sql<{ count: string }>`
        select count(*)::text as count from "auditEvents"
      `.execute(database);
      expect(events.rows[0]?.count).toBe("1");
    } finally {
      await gate.query("rollback").catch(() => undefined);
      gate.release();
      await writer.query("rollback").catch(() => undefined);
      writer.release();
    }
  });
});
