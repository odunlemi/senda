import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../src/config/env.js";
import { type Database, getDatabaseTime, setDb } from "../../src/lib/db.js";
import { ConflictError, NotFoundError } from "../../src/lib/errors.js";
import { logger } from "../../src/lib/logger.js";
import {
  applyWalletChangeRequest,
  cancelPendingWalletChange,
  setOrRequestMerchantWallet,
} from "./merchants.service.js";
import { isMerchantSessionFresh } from "./merchants.middleware.js";
import { processDueWalletChanges } from "./merchants.worker.js";

const connectionString =
  process.env.POSTGRES_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/senda";
const schema = `wallet_proof_${crypto.randomBytes(8).toString("hex")}`;
const serviceApplicationName = `senda-wallet-proof-${process.pid}`;
const migrationFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

let adminPool: Pool;
let controlPool: Pool;
let servicePool: Pool;
let database: Kysely<Database>;
let adminPoolReady = false;
let controlPoolReady = false;
let servicePoolReady = false;
let databaseReady = false;
let schemaCreated = false;
let setupComplete = false;

function address(byte: string): string {
  return `0x${byte.repeat(40)}`;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out`));
      }, 8_000);
      timer.unref();
    }),
  ]);
}

async function waitForLockWaiters(expected: number): Promise<number[]> {
  const deadline = Date.now() + 4_000;
  do {
    const result = await adminPool.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where application_name = $1 and wait_event_type = 'Lock' and state = 'active'
       order by pid`,
      [serviceApplicationName],
    );
    const pids = result.rows.map((row) => row.pid);
    if (pids.length >= expected) return pids;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  throw new Error(`Expected ${expected} PostgreSQL lock waiters`);
}

async function holdMerchantLock(merchantId: string): Promise<{
  pid: number;
  client: PoolClient;
}> {
  const client = await controlPool.connect();
  await client.query("begin");
  const identity = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  await client.query('select "id" from "user" where "id" = $1 for update', [merchantId]);
  return { pid: identity.rows[0]!.pid, client };
}

async function holdAddressLock(requestedAddress: string): Promise<{
  pid: number;
  client: PoolClient;
}> {
  const client = await controlPool.connect();
  await client.query("begin");
  const identity = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  await client.query(
    "select pg_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)",
    [requestedAddress],
  );
  return { pid: identity.rows[0]!.pid, client };
}

async function releaseGate(client: PoolClient): Promise<void> {
  try {
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function createMerchant(receivingWalletAddress: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto("user")
    .values({
      id,
      name: "PostgreSQL proof merchant",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      receivingWalletAddress,
    })
    .execute();
  return id;
}

async function createDueRequest(merchantId: string, requestedAddress: string): Promise<string> {
  const result = await setOrRequestMerchantWallet(merchantId, requestedAddress);
  if (result.kind !== "pending") throw new Error("Expected a pending wallet request");
  await sql`
    update "walletChangeRequests"
    set "requestedAt" = clock_timestamp() - interval '5 seconds',
        "activationAt" = clock_timestamp() - interval '1 second'
    where "id" = ${result.request.id}
  `.execute(database);
  return result.request.id;
}

async function eventCounts(merchantId: string): Promise<Record<string, number>> {
  const events = await database
    .selectFrom("auditEvents")
    .select(["eventType", ({ fn }) => fn.count("id").as("count")])
    .where("merchantId", "=", merchantId)
    .groupBy("eventType")
    .execute();
  return Object.fromEntries(events.map((event) => [event.eventType, Number(event.count)]));
}

beforeAll(async () => {
  adminPool = new Pool({ connectionString, max: 4 });
  adminPoolReady = true;
  await adminPool.query(`create schema "${schema}"`);
  schemaCreated = true;

  const poolOptions = `-c search_path=${schema},public -c lock_timeout=7000 -c statement_timeout=12000`;
  servicePool = new Pool({
    connectionString,
    max: 10,
    application_name: serviceApplicationName,
    options: poolOptions,
  });
  servicePoolReady = true;
  controlPool = new Pool({
    connectionString,
    max: 4,
    application_name: `${serviceApplicationName}-control`,
    options: poolOptions,
  });
  controlPoolReady = true;
  database = new Kysely<Database>({ dialect: new PostgresDialect({ pool: servicePool }) });
  databaseReady = true;

  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw new Error("PostgreSQL proof migrations failed", { cause: error });
  setDb(database);
  setupComplete = true;
});

beforeEach(async () => {
  await sql`delete from "auditEvents"`.execute(database);
  await sql`delete from "paymentIntents"`.execute(database);
  await sql`delete from "user"`.execute(database);
});

afterAll(async () => {
  vi.useRealTimers();
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };

  if (databaseReady) {
    await attempt(async () => {
      await database.destroy();
    });
  } else if (servicePoolReady) {
    await attempt(async () => {
      await servicePool.end();
    });
  }
  if (controlPoolReady) {
    await attempt(async () => {
      await controlPool.end();
    });
  }
  if (schemaCreated && adminPoolReady) {
    await attempt(async () => await adminPool.query(`drop schema if exists "${schema}" cascade`));
  }
  if (adminPoolReady) {
    await attempt(async () => {
      await adminPool.end();
    });
  }

  if (setupComplete && errors.length > 0) {
    throw new AggregateError(errors, "PostgreSQL proof cleanup failed");
  }
});

describe("wallet changes with independent PostgreSQL sessions", () => {
  it("lets exactly one of two blocked workers apply a due request", async () => {
    const merchantId = await createMerchant(address("1"));
    const requestId = await createDueRequest(merchantId, address("2"));
    const gate = await holdMerchantLock(merchantId);
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let gateReleased = false;
    let errorCalls = 0;

    try {
      const first = processDueWalletChanges();
      const firstPids = await waitForLockWaiters(1);
      const second = processDueWalletChanges();
      const pids = await waitForLockWaiters(2);
      expect(new Set(pids).size).toBeGreaterThanOrEqual(2);
      expect(pids).toEqual(expect.arrayContaining(firstPids));
      expect(pids).not.toContain(gate.pid);

      await releaseGate(gate.client);
      gateReleased = true;
      await withTimeout(Promise.all([first, second]), "concurrent wallet workers");
    } finally {
      if (!gateReleased) await releaseGate(gate.client);
      errorCalls = errorLog.mock.calls.length;
      errorLog.mockRestore();
    }

    expect(errorCalls).toBe(0);
    const request = await database
      .selectFrom("walletChangeRequests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe("applied");
    expect(await eventCounts(merchantId)).toEqual({
      "merchant.receiving_wallet_change_requested": 1,
      "merchant.receiving_wallet_change_applied": 1,
      "merchant.receiving_wallet_changed": 1,
    });
  });

  for (const firstOperation of ["activation", "cancellation"] as const) {
    it(`gives ${firstOperation} the deterministic first lock position`, async () => {
      const merchantId = await createMerchant(address("3"));
      const requestId = await createDueRequest(merchantId, address("4"));
      const gate = await holdMerchantLock(merchantId);
      let gateReleased = false;

      try {
        const activation = () => applyWalletChangeRequest(requestId);
        const cancellation = () => cancelPendingWalletChange(merchantId);
        const first = firstOperation === "activation" ? activation() : cancellation();
        await waitForLockWaiters(1);
        const second = firstOperation === "activation" ? cancellation() : activation();
        const pids = await waitForLockWaiters(2);
        expect(new Set(pids).size).toBeGreaterThanOrEqual(2);
        expect(pids).not.toContain(gate.pid);

        await releaseGate(gate.client);
        gateReleased = true;
        const outcomes = await withTimeout(
          Promise.allSettled([first, second]),
          `${firstOperation}-first wallet race`,
        );
        const request = await database
          .selectFrom("walletChangeRequests")
          .selectAll()
          .where("id", "=", requestId)
          .executeTakeFirstOrThrow();
        const activeWallet = await database
          .selectFrom("user")
          .select("receivingWalletAddress")
          .where("id", "=", merchantId)
          .executeTakeFirstOrThrow();
        const counts = await eventCounts(merchantId);

        if (firstOperation === "activation") {
          expect(request.status).toBe("applied");
          expect(activeWallet.receivingWalletAddress).toBe(address("4"));
          expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { kind: "applied" } });
          expect(outcomes[1]).toMatchObject({
            status: "rejected",
          });
          if (outcomes[1].status !== "rejected") throw new Error("Expected cancellation to lose");
          const reason: unknown = outcomes[1].reason;
          expect(reason).toBeInstanceOf(NotFoundError);
          expect((reason as Error).message).toBe("No pending wallet change request");
          expect(counts).toEqual({
            "merchant.receiving_wallet_change_requested": 1,
            "merchant.receiving_wallet_change_applied": 1,
            "merchant.receiving_wallet_changed": 1,
          });
        } else {
          expect(request.status).toBe("cancelled");
          expect(activeWallet.receivingWalletAddress).toBe(address("3"));
          expect(outcomes[0]).toMatchObject({
            status: "fulfilled",
            value: { status: "cancelled" },
          });
          expect(outcomes[1]).toMatchObject({
            status: "fulfilled",
            value: { kind: "already-terminal" },
          });
          expect(counts).toEqual({
            "merchant.receiving_wallet_change_requested": 1,
            "merchant.receiving_wallet_change_cancelled": 1,
          });
        }
      } finally {
        if (!gateReleased) await releaseGate(gate.client);
      }
    });
  }

  for (const firstOperation of ["reservation", "setup"] as const) {
    it(`gives ${firstOperation} first claim to a shared address`, async () => {
      const sharedAddress = address(firstOperation === "reservation" ? "5" : "6");
      const reservingMerchant = await createMerchant(address("7"));
      const setupMerchant = await createMerchant(null);
      const gate = await holdAddressLock(sharedAddress);
      let gateReleased = false;

      try {
        const reservation = () => setOrRequestMerchantWallet(reservingMerchant, sharedAddress);
        const setup = () => setOrRequestMerchantWallet(setupMerchant, sharedAddress);
        const first = firstOperation === "reservation" ? reservation() : setup();
        await waitForLockWaiters(1);
        const second = firstOperation === "reservation" ? setup() : reservation();
        const pids = await waitForLockWaiters(2);
        expect(new Set(pids).size).toBeGreaterThanOrEqual(2);
        expect(pids).not.toContain(gate.pid);

        await releaseGate(gate.client);
        gateReleased = true;
        const outcomes = await withTimeout(
          Promise.allSettled([first, second]),
          `${firstOperation}-first address race`,
        );
        expect(outcomes[0]).toMatchObject({
          status: "fulfilled",
          value: { kind: firstOperation === "reservation" ? "pending" : "immediate" },
        });
        expect(outcomes[1]).toMatchObject({
          status: "rejected",
        });
        if (outcomes[1].status !== "rejected") throw new Error("Expected second claim to lose");
        const reason: unknown = outcomes[1].reason;
        expect(reason).toBeInstanceOf(ConflictError);
        expect((reason as Error).message).toBe(
          firstOperation === "reservation"
            ? "Requested address is already pending for another merchant"
            : "Requested address is already in use by another merchant",
        );

        const active = await database
          .selectFrom("user")
          .select("id")
          .where("receivingWalletAddress", "=", sharedAddress)
          .execute();
        const pending = await database
          .selectFrom("walletChangeRequests")
          .select("merchantId")
          .where("requestedAddress", "=", sharedAddress)
          .where("status", "=", "pending")
          .execute();
        expect(active.length + pending.length).toBe(1);

        if (firstOperation === "reservation") {
          expect(pending).toEqual([{ merchantId: reservingMerchant }]);
          expect(await eventCounts(reservingMerchant)).toEqual({
            "merchant.receiving_wallet_change_requested": 1,
          });
          expect(await eventCounts(setupMerchant)).toEqual({});
        } else {
          expect(active).toEqual([{ id: setupMerchant }]);
          expect(await eventCounts(setupMerchant)).toEqual({
            "merchant.receiving_wallet_changed": 1,
          });
          expect(await eventCounts(reservingMerchant)).toEqual({});
        }
      } finally {
        if (!gateReleased) await releaseGate(gate.client);
      }
    });
  }

  it("starts the replacement delay after a forced merchant lock wait", async () => {
    const merchantId = await createMerchant(address("8"));
    const gate = await holdMerchantLock(merchantId);
    let gateReleased = false;

    try {
      const operation = setOrRequestMerchantWallet(merchantId, address("9"));
      const pids = await waitForLockWaiters(1);
      expect(pids).not.toContain(gate.pid);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const releasedAt = await gate.client.query<{ now: Date }>("select clock_timestamp() as now");
      await releaseGate(gate.client);
      gateReleased = true;
      const result = await withTimeout(operation, "lock-delayed replacement request");
      if (result.kind !== "pending") throw new Error("Expected a pending wallet request");

      expect(result.request.requestedAt.getTime()).toBeGreaterThanOrEqual(
        releasedAt.rows[0]!.now.getTime(),
      );
      expect(result.request.activationAt.getTime() - result.request.requestedAt.getTime()).toBe(
        env.MERCHANT_WALLET_CHANGE_DELAY_SECONDS * 1000,
      );
    } finally {
      if (!gateReleased) await releaseGate(gate.client);
    }
  });

  it("uses database time when the application clock is skewed", async () => {
    const merchantId = await createMerchant(address("a"));
    const beforeRequest = await getDatabaseTime();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2050-01-01T00:00:00.000Z"));
    const result = await setOrRequestMerchantWallet(merchantId, address("b"));
    vi.useRealTimers();
    if (result.kind !== "pending") throw new Error("Expected a pending wallet request");

    const afterRequest = await getDatabaseTime();
    expect(result.request.requestedAt.getTime()).toBeGreaterThanOrEqual(beforeRequest.getTime());
    expect(result.request.requestedAt.getTime()).toBeLessThanOrEqual(afterRequest.getTime());
    expect(result.request.activationAt.getTime() - result.request.requestedAt.getTime()).toBe(
      env.MERCHANT_WALLET_CHANGE_DELAY_SECONDS * 1000,
    );

    await sql`
      update "walletChangeRequests"
      set "requestedAt" = clock_timestamp(),
          "activationAt" = clock_timestamp() + interval '1 minute'
      where "id" = ${result.request.id}
    `.execute(database);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2050-01-01T00:00:00.000Z"));
    expect((await applyWalletChangeRequest(result.request.id)).kind).toBe("not-due");
    const apply = vi.fn(applyWalletChangeRequest);
    await processDueWalletChanges(apply);
    vi.useRealTimers();
    expect(apply).not.toHaveBeenCalled();

    await sql`
      update "walletChangeRequests"
      set "requestedAt" = clock_timestamp() - interval '5 seconds',
          "activationAt" = clock_timestamp() - interval '1 second'
      where "id" = ${result.request.id}
    `.execute(database);
    const beforeApply = await getDatabaseTime();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    await processDueWalletChanges();
    vi.useRealTimers();

    const afterApply = await getDatabaseTime();
    const applied = await database
      .selectFrom("walletChangeRequests")
      .innerJoin("user", "user.id", "walletChangeRequests.merchantId")
      .select(["walletChangeRequests.status", "walletChangeRequests.appliedAt", "user.updatedAt"])
      .where("walletChangeRequests.id", "=", result.request.id)
      .executeTakeFirstOrThrow();
    expect(applied.status).toBe("applied");
    expect(applied.appliedAt!.getTime()).toBeGreaterThanOrEqual(beforeApply.getTime());
    expect(applied.appliedAt!.getTime()).toBeLessThanOrEqual(afterApply.getTime());
    expect(applied.updatedAt.getTime()).toBe(applied.appliedAt!.getTime());

    const databaseTime = await getDatabaseTime();
    const freshCreatedAt = new Date(
      databaseTime.getTime() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS - 1) * 1000,
    );
    const staleCreatedAt = new Date(
      databaseTime.getTime() - (env.MERCHANT_SESSION_FRESH_AGE_SECONDS + 1) * 1000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2050-01-01T00:00:00.000Z"));
    expect(await isMerchantSessionFresh(freshCreatedAt)).toBe(true);
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    expect(await isMerchantSessionFresh(staleCreatedAt)).toBe(false);
    vi.useRealTimers();
  });
});
