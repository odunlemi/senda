# Migrations

Application migrations for merchant auth, payment intents, receipts, and other
Senda domain tables live here. Keep one migration path per schema so the
application and test databases are created from the same ordered history.

File naming: `<timestamp>_<description>.ts`, for example
`20260824120000_create_payment_intents.ts`. Each migration exports `up` and
`down` functions for Kysely's `FileMigrationProvider`.

Run migrations with `pnpm db:migrate` and roll back the latest migration with
`pnpm db:migrate:down`.
