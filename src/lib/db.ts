import { Kysely, PostgresDialect, sql } from "kysely";
import type { Transaction } from "kysely";
import { Pool } from "pg";

import { env } from "../config/env.js";
import type { AuditEventsTable } from "../../services/audit/audit-events.types.js";
import type { OperationalAlertDeliveriesTable } from "../../services/alerts/operational-alerts.types.js";
import type { PaymentIntentsTable } from "../../services/payment-intents/payment-intents.types.js";
import type {
  MerchantsTable,
  WalletChangeRequestsTable,
} from "../../services/merchants/merchants.types.js";

/**
 * Grows as each domain adds its own tables (payment intents, receipts, etc.).
 * Kept
 * here rather than per-service so Kysely's generated `db.selectFrom(...)`
 * stays type-checked across service boundaries without circular imports.
 */
export interface Database {
  paymentIntents: PaymentIntentsTable;
  user: MerchantsTable;
  auditEvents: AuditEventsTable;
  operationalAlertDeliveries: OperationalAlertDeliveriesTable;
  walletChangeRequests: WalletChangeRequestsTable;
}

let instance: Kysely<Database> = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: env.DATABASE_URL }),
  }),
});

/**
 * Services call this per-request rather than caching the result at module
 * load, so that `setDb` (test-only, see src/lib/testing.ts) takes effect for
 * every query a test issues, not just ones after a fresh import.
 */
export function getDb(): Kysely<Database> {
  return instance;
}

/**
 * Returns the database server's current wall time. Unlike PostgreSQL `now()`,
 * `clock_timestamp()` advances during a transaction, so callers can sample
 * the acceptance time after waiting for the locks that protect a transition.
 */
export async function getDatabaseTime(
  executor: Kysely<Database> | Transaction<Database> = getDb(),
): Promise<Date> {
  const result = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(executor);
  const now = result.rows[0]?.now;
  if (!now) throw new Error("Database did not return its current time");
  return now;
}

/** Test-only: swaps the live instance. Named exports can't be reassigned
 * from outside their module in ESM, so this setter is the actual mechanism.
 * See src/lib/testing.ts. */
export function setDb(next: Kysely<Database>): void {
  instance = next;
}
