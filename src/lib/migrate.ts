import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileMigrationProvider, Migrator } from "kysely/migration";

import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.join(__dirname, "..", "..", "migrations");

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down") {
    throw new Error("Usage: tsx src/lib/migrate.ts <up|down>");
  }

  const migrator = new Migrator({
    db: getDb(),
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });

  const { error, results } =
    direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();

  for (const result of results ?? []) {
    const line = `${result.status}: ${result.migrationName}`;
    if (result.status === "Error") console.error(line);
    else console.log(line);
  }

  if (error) {
    console.error(error);
    process.exit(1);
  }

  await getDb().destroy();
}

void main();
