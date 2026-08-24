import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { env } from "../config/env.js";
import type { PaymentIntentsTable } from "../../services/payment-intents/payment-intents.types.js";

/**
 * Grows as each domain adds its own tables (payment intents, receipts, etc.).
 * Kept
 * here rather than per-service so Kysely's generated `db.selectFrom(...)`
 * stays type-checked across service boundaries without circular imports.
 */
export interface Database {
  paymentIntents: PaymentIntentsTable;
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

/** Test-only: swaps the live instance. Named exports can't be reassigned
 * from outside their module in ESM, so this setter is the actual mechanism.
 * See src/lib/testing.ts. */
export function setDb(next: Kysely<Database>): void {
  instance = next;
}
