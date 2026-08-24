import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { afterAll, beforeAll } from "vitest";

import { type Database, setDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.join(__dirname, "..", "..", "migrations");

/**
 * Real Postgres SQL, real migrations, no network or Docker required: an
 * embedded, WASM Postgres per test file. This is a test-infrastructure
 * choice, not a stand-in for a provider. It exercises actual SQL against
 * actual schema, unlike the wallet/chain/swap adapters, which get real code
 * with no fake behind them (see docs/backend-plan.md).
 *
 * Call at the top of a test file, before any `db` import that needs it.
 * It replaces the module-level `db` export for the duration of the file.
 */
export function useTestDatabase(): void {
  let pglite: PGlite;

  beforeAll(async () => {
    pglite = new PGlite();
    const testDb = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });

    const migrator = new Migrator({
      db: testDb,
      provider: new FileMigrationProvider({ fs, path, migrationFolder }),
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw new Error("Test database migration failed", { cause: error });

    setDb(testDb);
  });

  afterAll(async () => {
    await pglite.close();
  });
}
