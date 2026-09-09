# Task C3 Reviewer Handoff

This is the historical pre-commit C3 handoff. Independent review accepted the
implementation as commit `7fa3136`, which was later deployed successfully to
production as `adad5bc8`. No Railway plan was applied during this development
handoff; the later operator-authorized rollout is recorded in
`docs/backend-completion-handoff.md`.

## Implementation

- Replaced the stale tracked `railway.json` with `.railway/railway.ts`.
- Preserved the API Dockerfile, compiled migration and start commands,
  `/api/health`, 100-second health timeout, one `ams` replica, disabled
  sleeping, and the on-failure restart policy capped at three retries.
- Preserved `OPERATIONAL_ALERT_WEBHOOK_URL`,
  `OPERATIONAL_ALERT_WEBHOOK_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `NODE_ENV`, and `OPERATIONAL_ALERTS_MODE` through `preserve()`.
- Defined `DATABASE_URL` through the private Postgres service reference.
- Modeled the existing Postgres volume without embedding identifiers,
  credentials, domains, or secret values.
- Kept `senda-alert-receiver` conditional on the staging environment.
- Added Railway SDK 3.11.0 and allowed ESLint to inspect the IaC file.

## Redacted Railway Plan

Railway CLI 5.49.6 evaluated `.railway/railway.ts` against the linked staging
environment:

```text
Plan: 0 to add, 3 to change, 0 to destroy

senda-api:
  builder: null -> DOCKERFILE
  dockerfilePath: null -> /Dockerfile
  restartPolicyType: null -> ON_FAILURE
  sleepApplication: null -> false

senda-alert-receiver:
  restartPolicyType: null -> ON_FAILURE
  sleepApplication: null -> false
```

The plan contains no database, volume, domain, credential, variable, service
creation, or deletion operation. No `config apply`, `config migrate --apply`,
or destructive option was run.

## Verification

- `pnpm install --frozen-lockfile --offline`: passed.
- `pnpm check`: passed with 150 tests in 14 files.
- `pnpm build`: passed.
- `git diff --check`: passed.
- Proposed commit message passed machine commitlint.

The existing `README.md` modification and all pre-existing untracked review
documents remain untouched and must not be included in the C3 commit.

## Intended Commit Files

- `.railway/railway.ts`
- `eslint.config.js`
- `package.json`
- `pnpm-lock.yaml`
- `railway.json` deletion

## Proposed Commit

```text
ci: track Railway service configuration

Replace the stale per-service file with Railway's project-level
TypeScript configuration. Preserve the proven API lifecycle, private
Postgres reference, secret variables, single-replica policy, and existing
production database volume.

Keep the controlled alert receiver limited to staging. Add the Railway
SDK for local planning and verify the redacted plan without applying
infrastructure changes.
```

Production deployment remains unauthorized. The reviewer/operator must inspect
the exact plan before any Railway apply, and the production PostgreSQL
credential rotation remains a separate production gate.
