# Migrations

Application migrations for payment intents, receipts, and other Senda domain
tables live here. Auth schema ownership should be decided when authentication
lands; do not introduce two competing migration paths for the same tables.

File naming: `<timestamp>_<description>.ts`, for example
`20260824120000_create_payment_intents.ts`. Each migration exports `up` and
`down` functions for Kysely's `FileMigrationProvider`.

Run migrations with `pnpm db:migrate` and roll back the latest migration with
`pnpm db:migrate:down`.
