# Task C4 Reviewer Handoff

This is the historical pre-commit C4 handoff. Independent review reproduced the
plans and accepted the implementation as commit `fa1b3d6`. No Railway plan was
applied, and this source-only configuration safeguard requires no deployment.

## Change

The shared `senda-api` environment in `.railway/railway.ts` now preserves these
existing runtime variables without storing their values in source:

- `BASE_RPC_URL`
- `TRUST_PROXY_HOPS`

No lifecycle, database, volume, domain, secret, receiver, or application-code
configuration was changed.

## Redacted Production Plan

Railway CLI 5.50.2 reported:

```text
Project earnest-strength
Environment production

Plan: 0 to add, 1 to change, 0 to destroy
  ~ Update senda-api deploy.restartPolicyType, deploy.sleepApplication
    restartPolicyType: null -> ON_FAILURE
    sleepApplication: null -> false
```

This is the previously documented null-versus-effective lifecycle reporting
drift. The active production deployment manifest already reports
`restartPolicyType: ON_FAILURE`, a maximum of three retries, and
`sleepApplication: false`.

## Redacted Staging Plan

Railway CLI 5.50.2 reported:

```text
Project earnest-strength
Environment staging

Plan: 0 to add, 3 to change, 0 to destroy
  ~ Update senda-api build.builder, build.dockerfilePath
    builder: null -> DOCKERFILE
    dockerfilePath: null -> /Dockerfile
  ~ Update senda-api deploy.restartPolicyType, deploy.sleepApplication
    restartPolicyType: null -> ON_FAILURE
    sleepApplication: null -> false
  ~ Update senda-alert-receiver deploy.restartPolicyType,
    deploy.sleepApplication
    restartPolicyType: null -> ON_FAILURE
    sleepApplication: null -> false
```

Neither plan deletes `BASE_RPC_URL` or `TRUST_PROXY_HOPS`. Neither plan changes
PostgreSQL, its volume, domains, secrets, or the staging-only receiver topology.
No `railway config apply` or destructive option was run.

## Verification

- `pnpm check`: passed with 150 tests in 14 files.
- `pnpm build`: passed.
- `git diff --check`: passed.
- The exact proposed message passed machine commitlint.

## Intended Commit File

- `.railway/railway.ts`

All reviewer documents, analysis files, and earlier handoff files remain
untouched and must remain unstaged.

## Proposed Commit

```text
ci: preserve Railway runtime variables

Preserve the Base RPC and trusted-proxy settings in project-level
Railway configuration so production plans cannot remove valid runtime
values.

Retain the reviewed lifecycle policy. Verify redacted staging and
production plans without applying the persistent Railway default-value
drift.
```
