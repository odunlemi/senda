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
| `pnpm db:migrate`      | Runs pending Kysely migrations against `DATABASE_URL`. |
| `pnpm db:migrate:down` | Rolls back the most recent Kysely migration.           |
| `pnpm build`           | Builds the production TypeScript output.               |
| `pnpm start`           | Starts the production server.                          |

## Payment Lifecycle

```text
created -> awaiting_payment -> confirming -> paid
                       \\-> expired

confirming -> failed
```

The backend must still record transaction hashes, provider event IDs,
idempotency keys, confirmation counts, retries, and failure details. These
fields support reliable reconciliation without making the customer-facing
flow complicated.

## Testing

`useTestDatabase()` in `src/lib/testing.ts` runs real migrations against an
embedded PGlite database per test file. Tests exercise real SQL without a
separate database, network connection, or Docker container.

## Deploying

`railway.json` configures the build, migrations, start command, and health
check. Attach a Railway Postgres plugin and set `DATABASE_URL` to its reference
variable: `${{Postgres.DATABASE_URL}}`.

When the web UI lands, the production server should serve it from the same
origin as the API. A separate frontend deployment and cross-origin cookie
setup are not required for the MVP.
