import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { paymentConfig } from "../../src/config/payment.js";
import { type Database, getDatabaseTime, setDb } from "../../src/lib/db.js";
import { setBaseTransactionProvider } from "./checkout.provider.js";
import { reconcileCheckout } from "./checkout.service.js";

const connectionString =
  process.env.POSTGRES_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/senda";
const schema = `checkout_proof_${crypto.randomBytes(8).toString("hex")}`;
const migrationFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

let adminPool: Pool;
let servicePool: Pool;
let database: Kysely<Database>;
let adminPoolReady = false;
let servicePoolReady = false;
let databaseReady = false;
let schemaCreated = false;
let setupComplete = false;

async function insertConfirmingPayment(submittedAt: Date): Promise<string> {
  const publicId = crypto.randomUUID();
  const now = await getDatabaseTime(database);
  await database
    .insertInto("paymentIntents")
    .values({
      id: crypto.randomUUID(),
      merchantId: "checkout-clock-merchant",
      publicId,
      amountAtomic: "1000000",
      asset: paymentConfig.asset,
      chain: paymentConfig.chain,
      destinationAddress: "0x1111111111111111111111111111111111111111",
      description: null,
      reference: null,
      status: "confirming",
      expiresAt: new Date(now.getTime() + 60_000),
      payerAddress: "0x2222222222222222222222222222222222222222",
      transactionHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      confirmationCount: 0,
      providerEventId: null,
      submittedAt,
      monitoringExpiresAt: new Date(submittedAt.getTime() + paymentConfig.droppedMonitoringMs),
      monitoringEscalatedAt: null,
      paidAt: null,
      reorgDetectedAt: null,
      createdAt: now,
      updatedAt: submittedAt,
    })
    .execute();
  return publicId;
}

beforeAll(async () => {
  adminPool = new Pool({ connectionString, max: 2 });
  adminPoolReady = true;
  await adminPool.query(`create schema "${schema}"`);
  schemaCreated = true;

  servicePool = new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${schema},public -c statement_timeout=12000`,
  });
  servicePoolReady = true;
  database = new Kysely<Database>({ dialect: new PostgresDialect({ pool: servicePool }) });
  databaseReady = true;

  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
    migrationTableSchema: schema,
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw new Error("Checkout PostgreSQL proof migrations failed", { cause: error });
  setDb(database);

  await database
    .insertInto("user")
    .values({
      id: "checkout-clock-merchant",
      name: "Checkout Clock Merchant",
      email: "checkout-clock@example.com",
      emailVerified: false,
      image: null,
      receivingWalletAddress: "0x1111111111111111111111111111111111111111",
    })
    .execute();
  setupComplete = true;
});

afterAll(async () => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };

  if (databaseReady) {
    await attempt(async () => database.destroy());
  } else if (servicePoolReady) {
    await attempt(async () => servicePool.end());
  }
  if (schemaCreated && adminPoolReady) {
    await attempt(async () => adminPool.query(`drop schema if exists "${schema}" cascade`));
  }
  if (adminPoolReady) {
    await attempt(async () => adminPool.end());
  }

  if (setupComplete && errors.length > 0) {
    throw new AggregateError(errors, "Checkout PostgreSQL proof cleanup failed");
  }
});

describe("checkout timing with PostgreSQL server time", () => {
  it("ignores an application clock that is ahead of the monitoring deadline", async () => {
    const submittedAt = await getDatabaseTime(database);
    const publicId = await insertConfirmingPayment(submittedAt);
    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(submittedAt.getTime() + 86_400_000);
    try {
      await reconcileCheckout(publicId, { automated: true });
    } finally {
      dateNow.mockRestore();
    }

    const row = await database
      .selectFrom("paymentIntents")
      .select(["status", "monitoringEscalatedAt"])
      .where("publicId", "=", publicId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "confirming", monitoringEscalatedAt: null });
  });

  it("times out a stale submission when the application clock is behind", async () => {
    const databaseNow = await getDatabaseTime(database);
    const submittedAt = new Date(databaseNow.getTime() - paymentConfig.confirmingTimeoutMs - 1000);
    const publicId = await insertConfirmingPayment(submittedAt);
    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(databaseNow.getTime() - 86_400_000);
    try {
      await reconcileCheckout(publicId, { automated: true });
    } finally {
      dateNow.mockRestore();
    }

    const row = await database
      .selectFrom("paymentIntents")
      .select("status")
      .where("publicId", "=", publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("dropped");
  });
});
