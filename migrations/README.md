# Migrations

Application migrations for merchant auth, payment intents, receipts, and other
Senda domain tables live here. Keep one migration path per schema so the
application and test databases are created from the same ordered history.

File naming: `<timestamp>_<description>.ts`, for example
`20260824120000_create_payment_intents.ts`. Each migration exports `up` and
`down` functions for Kysely's `FileMigrationProvider`.

Run migrations with `pnpm db:migrate` and roll back the latest migration with
`pnpm db:migrate:down`.

The late-settlement monitoring migration gives pre-existing `confirming` and
`dropped` hashes a fresh 24-hour monitoring window at deployment. Run the
migration before deploying application code that writes `submittedAt` and
`monitoringExpiresAt`.

## Wallet-change rollback boundary

Migration `20260907020000_guard_wallet_change_rollback.ts` is the supported
rollback boundary for delayed wallet changes. Once any requested, cancelled,
or applied wallet-change audit event exists, do not roll the database back past
this migration. Its `down` preflight intentionally fails before changing the
schema or migration history. Never delete or rewrite security audit events to
make rollback succeed.

To roll application behavior back after the boundary has been crossed, stop the
worker and API writes and retain the forward database schema. Build a rollback
release that reverts the application behavior but still contains every
already-applied migration file, including this boundary migration. A plain
historical release artifact is not supported: Railway runs `pnpm db:migrate`
before deployment, and Kysely rejects an executed migration that is absent from
the release. Prepare a forward repair if one is needed.

Before the first wallet-change event exists, a planned schema rollback may
proceed only with writers stopped; verify that the following query returns zero
rows, take a database backup, and run one migration step at a time:

```sql
select "eventType"
from "auditEvents"
where "eventType" in (
  'merchant.receiving_wallet_change_requested',
  'merchant.receiving_wallet_change_cancelled',
  'merchant.receiving_wallet_change_applied'
)
limit 1;
```
