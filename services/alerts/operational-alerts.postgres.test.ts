import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { env } from "../../src/config/env.js";
import { type Database, getDatabaseTime, setDb } from "../../src/lib/db.js";
import { recordAuditEvent } from "../audit/audit-events.service.js";
import { dispatchOperationalAlerts } from "./operational-alerts.dispatcher.js";
import type { OperationalAlertDeliveryAdapter } from "./operational-alerts.provider.js";

const connectionString =
  process.env.POSTGRES_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/senda";
const schema = `operational_alerts_${crypto.randomBytes(8).toString("hex")}`;
const migrationFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

let adminPool: Pool;
let servicePool: Pool;
let controlPool: Pool;
let database: Kysely<Database>;
let setupComplete = false;

const originalConfig = {
  batchSize: env.OPERATIONAL_ALERT_BATCH_SIZE,
  leaseMs: env.OPERATIONAL_ALERT_LEASE_MS,
};

async function createMerchant(): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto("user")
    .values({
      id,
      name: "PostgreSQL Alert Merchant",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      receivingWalletAddress: "0x1111111111111111111111111111111111111111",
    })
    .execute();
  return id;
}

async function insertAlerts(merchantId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = await database.transaction().execute(async (trx) => {
      const now = await getDatabaseTime(trx);
      await recordAuditEvent(trx, {
        eventType: "merchant.receiving_wallet_change_requested",
        actorType: "merchant",
        actorId: merchantId,
        merchantId,
        paymentIntentId: null,
        metadata: {},
        createdAt: now,
        operationalAlert: {
          eventKind: "merchant.receiving_wallet_change_requested",
          merchantId,
          walletChangeRequestId: crypto.randomUUID(),
        },
      });
      return await trx
        .selectFrom("operationalAlertDeliveries")
        .select("id")
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow();
    });
    ids.push(id.id);
  }
  return ids;
}

beforeAll(async () => {
  adminPool = new Pool({ connectionString, max: 2 });
  await adminPool.query(`create schema "${schema}"`);
  const options = `-c search_path=${schema},public -c statement_timeout=12000`;
  servicePool = new Pool({ connectionString, max: 8, options });
  controlPool = new Pool({ connectionString, max: 2, options });
  database = new Kysely<Database>({ dialect: new PostgresDialect({ pool: servicePool }) });

  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
    migrationTableSchema: schema,
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw new Error("Operational alert PostgreSQL migrations failed", { cause: error });
  setDb(database);
  setupComplete = true;
});

beforeEach(async () => {
  env.OPERATIONAL_ALERT_BATCH_SIZE = 2;
  env.OPERATIONAL_ALERT_LEASE_MS = 60_000;
  await sql`delete from "operationalAlertDeliveries"`.execute(database);
  await sql`delete from "auditEvents"`.execute(database);
  await sql`delete from "user"`.execute(database);
});

afterAll(async () => {
  env.OPERATIONAL_ALERT_BATCH_SIZE = originalConfig.batchSize;
  env.OPERATIONAL_ALERT_LEASE_MS = originalConfig.leaseMs;
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt(async () => database.destroy());
  await attempt(async () => controlPool.end());
  await attempt(async () => adminPool.query(`drop schema if exists "${schema}" cascade`));
  await attempt(async () => adminPool.end());
  if (setupComplete && errors.length > 0) {
    throw new AggregateError(errors, "Operational alert PostgreSQL cleanup failed");
  }
});

describe("operational alert dispatcher concurrency", () => {
  it("lets independent workers claim each due row once", async () => {
    const merchantId = await createMerchant();
    const deliveryIds = await insertAlerts(merchantId, 4);
    const received = new Map<string, number>();
    const adapter: OperationalAlertDeliveryAdapter = {
      deliver: (payload) => {
        received.set(payload.deliveryId, (received.get(payload.deliveryId) ?? 0) + 1);
        return Promise.resolve({ outcome: "accepted", httpStatus: 204 });
      },
    };

    const summaries = await Promise.all([
      dispatchOperationalAlerts(adapter),
      dispatchOperationalAlerts(adapter),
    ]);

    expect(summaries.map((summary) => summary.claimed).sort()).toEqual([2, 2]);
    expect([...received.keys()].sort()).toEqual([...deliveryIds].sort());
    expect([...received.values()]).toEqual([1, 1, 1, 1]);
    const delivered = await database
      .selectFrom("operationalAlertDeliveries")
      .select(({ fn }) => fn.count("id").as("count"))
      .where("status", "=", "delivered")
      .executeTakeFirstOrThrow();
    expect(Number(delivered.count)).toBe(4);
  });

  it("commits the claim before making the external request", async () => {
    const merchantId = await createMerchant();
    const deliveryId = (await insertAlerts(merchantId, 1))[0];
    if (!deliveryId) throw new Error("Expected an operational alert delivery");
    const adapter: OperationalAlertDeliveryAdapter = {
      deliver: async () => {
        const client = await controlPool.connect();
        try {
          await client.query("begin");
          await expect(
            client.query(
              'select "id" from "operationalAlertDeliveries" where "id" = $1 for update nowait',
              [deliveryId],
            ),
          ).resolves.toBeDefined();
          await client.query("commit");
        } finally {
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
        return { outcome: "accepted", httpStatus: 204 };
      },
    };

    await expect(dispatchOperationalAlerts(adapter)).resolves.toMatchObject({ delivered: 1 });
  });

  it("ignores an old worker result after a newer lease owns the row", async () => {
    env.OPERATIONAL_ALERT_BATCH_SIZE = 1;
    const merchantId = await createMerchant();
    const deliveryId = (await insertAlerts(merchantId, 1))[0];
    if (!deliveryId) throw new Error("Expected an operational alert delivery");
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstAdapter: OperationalAlertDeliveryAdapter = {
      deliver: async () => {
        markFirstStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { outcome: "accepted", httpStatus: 204 };
      },
    };

    const oldWorker = dispatchOperationalAlerts(firstAdapter);
    await firstStarted;
    await sql`
      update "operationalAlertDeliveries"
      set "lastAttemptAt" = clock_timestamp() - interval '2 seconds',
          "leasedUntil" = clock_timestamp() - interval '1 second'
      where "id" = ${deliveryId}
    `.execute(database);

    const newerWorker = await dispatchOperationalAlerts({
      deliver: () => Promise.resolve({ outcome: "accepted", httpStatus: 202 }),
    });
    releaseFirst?.();
    const oldSummary = await oldWorker;

    expect(newerWorker).toMatchObject({ delivered: 1, staleResults: 0 });
    expect(oldSummary).toMatchObject({ delivered: 0, staleResults: 1 });
    const row = await database
      .selectFrom("operationalAlertDeliveries")
      .select(["status", "attemptCount", "lastHttpStatus"])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "delivered", attemptCount: 2, lastHttpStatus: 202 });
  });
});
