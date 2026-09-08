# senda

Senda is a simple, crypto-native payment link product. A business creates a
payment link or embeddable button, a customer explicitly approves one payment,
and both sides receive a receipt containing the blockchain transaction hash.

The active product and backend direction is documented in
[`docs/backend-plan.md`](docs/backend-plan.md).

## MVP Scope

- one blockchain and one stablecoin;
- one receiving wallet per business;
- one-time payments through Senda's guided checkout;
- payment links and embeddable buttons;
- confirmation-aware payment status;
- receipts containing the transaction hash.

The MVP does not include subscriptions, arbitrary external transfers, pooled
balances, FX execution, cross-chain swaps, or a full accounting invoice
system. A payment link is modeled as a payment intent with optional
description and reference metadata.

## Repository Shape

Senda is a monorepo. The API is currently the first application at the
repository root. The web UI will be added under `apps/web` and deployed with
the API from one origin.

```text
src/            API wiring: environment, database, logger, middleware, entrypoint.
services/       Domain services as they are implemented.
contracts/      Shared request and response schemas.
migrations/     Kysely migrations for application tables.
apps/web/       Web application when it is added.
docs/           Active Senda product and backend plan.
```

The first domain services should stay small: merchant access, payment
intents, checkout/payment verification, and receipts.

## Quickstart

```bash
corepack enable
pnpm install
cp .env.example .env   # set BETTER_AUTH_SECRET; DATABASE_URL matches docker-compose.yml
docker compose up -d   # wait for Postgres to become healthy
pnpm db:migrate
pnpm dev
```

## Scripts

| Script                 | Does                                                   |
| ---------------------- | ------------------------------------------------------ |
| `pnpm dev`             | Runs the API with hot reload.                          |
| `pnpm check`           | Runs typecheck, lint, format check, and tests.         |
| `pnpm test:postgres`   | Runs lock-contention tests against local PostgreSQL.   |
| `pnpm db:migrate`      | Runs pending Kysely migrations against `DATABASE_URL`. |
| `pnpm db:migrate:down` | Rolls back the most recent Kysely migration.           |
| `pnpm build`           | Builds the production TypeScript output.               |
| `pnpm start`           | Starts the production server.                          |

## Payment Lifecycle

```text
created -> awaiting_payment -> confirming -> paid
created/awaiting_payment -> expired
confirming -> failed | dropped
dropped -> confirming | failed | paid
paid -> paid (terminal)
```

`dropped` means that the submitted hash has no available receipt after the
five-minute confirmation timeout. It is unresolved, not failed: the worker
keeps checking the original hash for 24 hours, and a later valid receipt can
move it back to `confirming` or directly to `paid`. A paid intent remains
terminal.

## Testing

`useTestDatabase()` in `src/lib/testing.ts` runs real migrations against an
embedded PGlite database per test file. Tests exercise real SQL without a
separate database, network connection, or Docker container.

Wallet lock-contention evidence uses independent PostgreSQL sessions and is
kept in a separate suite. Start the Compose database, then run:

```bash
docker compose up -d postgres
pnpm test:postgres
```

The suite defaults to the Compose connection and creates a unique disposable
schema. Set `POSTGRES_TEST_DATABASE_URL` to use another test-only PostgreSQL
database. Never point this variable at production.

## Operations

Rate limiting is configured through `TRUST_PROXY_HOPS` and the `RATE_LIMIT_*`
environment variables. Set `TRUST_PROXY_HOPS` to the number of trusted reverse
proxies between the Railway deployment and the public internet so client IP
budgets are keyed on the real client, not on an internal proxy.

The limiter uses an in-memory store. This is correct for the current single
API process, but a shared external store such as Redis is required before
running multiple API instances behind a load balancer.

Merchant sessions are valid for their full lifetime, but a session is only
considered fresh for `MERCHANT_SESSION_FRESH_AGE_SECONDS` (default 300). The
`PUT /api/merchant-wallet` and `DELETE /api/merchant-wallet/pending` endpoints
require a fresh session; a 403 response means the merchant must reauthenticate
through `POST /api/merchant-sessions` and then retry the request.

Replacing an already-configured receiving wallet creates a pending change that
becomes active after `MERCHANT_WALLET_CHANGE_DELAY_SECONDS` (default 86400).
Payment links created during the delay continue to use the previous address,
and the merchant can cancel the pending request until it is applied.
Payment-link creation and wallet activation are serialized by the merchant row:
a link ordered before activation stores the old address, while one ordered
after activation stores the new address. Existing links retain their stored
destination regardless of later wallet changes; HTTP response order does not
define this database ordering.

For unresolved payments, monitor warning logs containing `unresolved payment
monitoring escalated` and query `paymentIntents` rows where `status in
('confirming', 'dropped')` and `monitoringEscalatedAt is not null`. Verify the
stored `transactionHash` with the configured Base RPC and trigger the existing
manual reconciliation endpoint if a receipt becomes available. Preserve the
hash and payment row, and do not direct the customer to submit a second
payment. Automated polling ends at the 24-hour `monitoringExpiresAt` deadline,
even during an RPC outage, but manual reconciliation continues to accept a
later valid receipt.

### Operational alerts

Security-sensitive wallet replacement transitions and paid-payment reorg
detections enqueue an operator alert in the same transaction as their domain
change and audit event. The migration is the cutover: existing audit events are
not backfilled. Initial wallet setup and the compatibility
`merchant.receiving_wallet_changed` event do not enqueue an alert.

Make that cutover coordinated: pause API and worker writes, apply the migration,
deploy the alert-producing application, then resume writes. Railway runs the
migration before replacing the old application. If old code is allowed to
commit one of these audit events after the migration, it has no outbox row and
is intentionally not reconstructed later.

`OPERATIONAL_ALERTS_MODE=disabled` leaves delivery off while continuing to
build the durable backlog. This is suitable for development or a controlled
maintenance window, but it is not an operationally complete production mode.
Setting the mode to `webhook` without both `OPERATIONAL_ALERT_WEBHOOK_URL` and
`OPERATIONAL_ALERT_WEBHOOK_TOKEN` fails environment validation at startup. For
production, configure all three as server-only Railway variables. The URL must
use HTTPS, name an operator-controlled receiver, and never come from merchant
or public request input. Redirects are not followed.

The dispatcher sends an authenticated `POST` with these headers:

```text
Authorization: Bearer <OPERATIONAL_ALERT_WEBHOOK_TOKEN>
Content-Type: application/json
Idempotency-Key: <stable delivery UUID>
X-Senda-Event: <event kind>
```

The strict version 1 JSON body contains the same delivery UUID, event time,
event kind, and allowlisted subject identifiers. Wallet alerts contain merchant
and wallet-change-request IDs plus cancellation actor and safe reason when
applicable. Reorg alerts contain merchant, internal payment-intent, public
payment, and reason identifiers. Wallet addresses, transaction hashes,
credentials, cookies, raw provider responses, and arbitrary audit metadata are
not delivered.

Delivery is at least once, not exactly once. A process can crash after the
receiver accepts a request but before Senda records success. The expired lease
is then reclaimed and the same `Idempotency-Key` is sent again; the receiver
must deduplicate on that value. Requests have a finite timeout. Network errors,
timeouts, HTTP 408, 425, 429, and 5xx responses retry with capped exponential
backoff. Other 4xx responses become `failed`; retryable responses become
`exhausted` after `OPERATIONAL_ALERT_MAX_ATTEMPTS` recorded failures.
If that limit is reduced, pending rows already at the new ceiling move to
`exhausted` in bounded worker batches instead of remaining ineligible forever.

Use service logs containing `operational alert worker started` and
`operational alert worker cycle completed`, together with Railway process
monitoring, to check worker availability independently of the webhook itself.
Inspect backlog age and delivery state with:

```sql
select "status", count(*) as deliveries,
       min("createdAt") as oldest_created_at,
       clock_timestamp() - min("createdAt") as oldest_age,
       min("nextAttemptAt") as next_due_at,
       min("leasedUntil") as earliest_lease_expiry,
       min("failedAt") as earliest_terminal_at
from "operationalAlertDeliveries"
group by "status"
order by "status";

select "id", "eventKind", "status", "attemptCount", "nextAttemptAt",
       "leasedUntil", "lastErrorCode", "lastHttpStatus", "updatedAt"
from "operationalAlertDeliveries"
where "status" in ('pending', 'processing', 'failed', 'exhausted')
order by "createdAt"
limit 100;
```

Before replaying a `failed` or `exhausted` row, fix and verify the destination,
record the delivery ID, and reset only that row. Preserve its original ID and
payload so receiver deduplication remains effective:

```sql
begin;
select "id", "eventKind", "payload" from "operationalAlertDeliveries"
where "id" = '<delivery UUID>' for update;
update "operationalAlertDeliveries"
set "status" = 'pending', "attemptCount" = 0,
    "nextAttemptAt" = clock_timestamp(),
    "leaseToken" = null, "leasedUntil" = null, "deliveredAt" = null,
    "lastAttemptAt" = null, "failedAt" = null, "lastErrorCode" = null,
    "lastHttpStatus" = null,
    "updatedAt" = clock_timestamp()
where "id" = '<delivery UUID>' and "status" in ('failed', 'exhausted');
commit;
```

Resetting the attempt counter starts a new bounded delivery cycle while the
original delivery ID and payload remain unchanged. The status filter prevents
replay from taking an active lease away from a worker.

For a controlled delivery smoke test, point the staging variables at a test
receiver that returns 2xx, initiate one test wallet replacement, and verify the
bearer header, stable idempotency key, strict payload, and final `delivered`
row. Never use a real paging or merchant endpoint from automated tests.

## Deploying

`railway.json` configures the build, migrations, start command, and health
check. Attach a Railway Postgres plugin and set `DATABASE_URL` to its reference
variable: `${{Postgres.DATABASE_URL}}`.

When the web UI lands, the production server should serve it from the same
origin as the API. A separate frontend deployment and cross-origin cookie
setup are not required for the MVP.
