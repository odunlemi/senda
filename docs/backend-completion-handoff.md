# Backend Completion and Review Handoff

Review snapshot: 2026-09-09. The Task B message-only amend, controlled Railway
staging delivery, and Railway-managed migration lifecycle are accepted. C1 is
deployed successfully to staging as `4dde42cf`. Grafana Cloud IRM is the
selected human-notification target. Direct delivery from the API to Grafana
passes in staging, including grouping, escalation, and email notification. C3
is pushed, and accepted commit `7fa3136` is deployed successfully to production
as `adad5bc8`. C4 is accepted as `fa1b3d6` and requires no deployment. This
document does not authorize a later production release. Read it with
`review-changes.md`, `docs/backend-plan.md`, and `docs/commit-spec.md`.

For the operator's first-time deployment steps and the live service snapshot,
see [the Railway deployment guide](railway-deploy-guide.md). Grafana Cloud IRM
is the selected human-notification system. The current staging receiver remains
a controlled test mailbox; it is not required in production if direct Grafana
delivery passes the staging proof.

## Status Against the Backend Plan

| Step                                      | Implementation evidence                                                                         | Status                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1. Chain and stablecoin                   | `src/config/payment.ts`: Base, USDC, 12 confirmations                                           | Implemented; preserve this policy.                                                 |
| 2. Merchant identity and receiving wallet | Merchant auth, canonical ownership, fresh authentication, delayed replacement through `88618ff` | Implemented; Task A is accepted.                                                   |
| 3. Payment intents and public links       | `services/payment-intents`, merchant-derived destination snapshot                               | Activation ordering is implemented and accepted in `703a9c4`.                      |
| 4. Guided checkout                        | `services/checkout`, exact direct USDC transaction construction and verification                | Existing API implemented; selected embedded customer experience belongs to `flow`. |
| 5. Confirmation and reconciliation        | Worker, timeout, transfer-log validation, terminal paid reorg monitoring                        | Late-settlement recovery is implemented and accepted in `b2145e9`.                 |
| 6. Receipts                               | `5fed816`, paid-only receipt and settlement-review signal                                       | Implemented.                                                                       |
| 7. Hardening                              | Rate limits, durable audit, fresh sessions, delayed replacement and cancellation                | C1 and the complete Grafana notification proof are accepted.                       |

Cancellation during the replacement delay is the currently agreed merchant
recovery control. Password reset, two-factor authentication, merchant ownership
signatures, and compensation are separate scope, not implicit additions to this
closure task. Customer account and wallet recovery remain required by the later
customer-flow plan.

## Task A: Close the Remaining Wallet Proof Requirements

Review update, 2026-09-08: Task A is accepted and committed as `88618ff`. Exact
active-wallet assertions cover both PostgreSQL activation/cancellation
orderings, partial-setup teardown preserves the original connection failure,
and the commit satisfies `docs/commit-spec.md`.

Commit `8cb28d6` already added the four groups requested by the previous review:
worker error-log assertions, reservation versus initial setup, audit failure in
three transitions, and worker failure followed by retry. Do not reimplement
delayed replacement or treat these tests as absent.

The accepted Task A evidence covers the following requirements:

1. Add a focused integration test path using disposable PostgreSQL and at least
   two independent database sessions. The current `useTestDatabase()` creates
   one PGlite connection; overlapping JavaScript calls do not prove PostgreSQL
   lock contention. Keep the fast PGlite suite for ordinary API and SQL tests.
2. Use controlled overlap, bounded timeouts, and separate session identities to
   exercise two due workers, cancellation versus activation, and replacement
   reservation versus another merchant's first setup. Exercise both operation
   orderings. Assert one winning state, handled loser behavior, exact audit
   counts, and no unexpected worker errors or deadlocks. Demonstrate that the
   tests would detect removal of the relevant synchronization.
3. Extend audit rollback tests to snapshot the exact active wallet, complete
   request state and timestamps, and relevant audit rows before failure. Assert
   equality after failure for request creation, cancellation, and application.
   Application writes two audit events: independently fail the second insert
   after the first succeeds and prove both events and both state writes roll
   back. Include system cancellation on activation conflict.
4. Prove database-clock authority by skewing the application clock forward and
   backward while the database clock remains independent. Check request delay,
   direct early application, worker eligibility, and due application. Fixture
   dates derived from `Date.now()` alone do not prove this property. PostgreSQL
   `now()` is the transaction-start timestamp: define the delay's start point
   explicitly and test a forced lock wait before scheduling. Capture database
   wall time after acquiring the required locks if scheduling is intended to
   start at acceptance. Also make fresh-session security checks use database
   time; `merchants.middleware.ts:44` currently uses the application clock.
5. Preserve the existing worker failure/retry test, migration constraints and
   index checks, fresh-session behavior, 200/202/409 contracts, and payment-link
   destination snapshots. Run the required checks and the PostgreSQL integration
   suite, and record exact results and any execution limitations.

These are evidence requirements, not a claim that a production deadlock or
partial commit has been reproduced. Fix implementation defects if the stronger
tests expose them. Use forward migrations for any schema correction.

## Task A2: Resolve Payment and Migration Review Findings

Review update, 2026-09-08: Task A2 is fully accepted in `b2145e9`, `703a9c4`,
and `e006bbf`. The review found no source-code correction: 122 regular tests, 14
PostgreSQL integration tests, typecheck, lint, formatting, build, and diff checks
passed. The final commit messages pass machine commitlint and the manual 50/72
limits. Each amended commit has the exact tree of its technically accepted
predecessor, so no implementation changed during message correction. The three
behavior changes remain separated coherently.

The accepted implementation addresses the three historical findings below. They
remain here as the acceptance record.

### High: A Missing Receipt Does Not Establish a Failed Payment

At `8cb28d6`, `checkout.service.ts:194-220` stopped reconciling `dropped` intents
permanently. The worker selected only `confirming` and `paid` rows. If a receipt
was absent after the timeout but later became visible and reached 12
confirmations, the existing hash could never become paid through those paths.
The previous frontend plan told the customer a new link was needed and stopped
polling. This could cause an unrecognized successful payment and encourage a
second payment.

The planning edit at `8cb28d6` removed that recommendation and marked corrected
polling/recovery as a backend dependency. The accepted A2 implementation now
provides that runtime and public-contract correction.

This is established by tracing the current code paths; a live-chain failure
was not reproduced. The absence of a receipt is not evidence that a broadcast
transaction can no longer settle.

Required outcome:

1. Keep the original hash associated and recoverable after timeout. Define a
   bounded monitoring/escalation policy for unresolved transactions and a path
   for later valid settlement. Do not weaken transaction or transfer-log
   verification and never reverse an already-paid intent.
2. Add tests for no receipt after timeout, then a valid 12-confirmation receipt;
   worker restart and retries; timeout versus payment acceptance races; exact
   receipt availability; and no duplicate association or acceptance. If the
   timeout is based on time since submission, persist an immutable start time
   instead of relying on `updatedAt`, which reconciliation changes.
3. Update the state model, shared contracts, frontend dropped-state copy and
   polling policy, and operator procedure together. Do not tell the customer to
   pay again solely because a receipt lookup timed out. Use a forward migration
   if persistence or state constraints change.

### Medium: Order Payment-Link Creation Against Wallet Activation

`payment-intents.service.ts:44-76` reads the receiving address and inserts the
intent in separate autocommit operations. An overlapping activation can commit
between those operations, allowing a new row to snapshot the old address after
the wallet switch. The plan does not define this overlapping-operation boundary
precisely; settle it explicitly as part of wallet acceptance.

Read/lock the merchant and insert the intent in one transaction with a lock
order compatible with activation. Prove with independent PostgreSQL sessions
that creation and activation have a deterministic database order: creation
before activation stores the old address; creation after it stores the new one.
Preserve destinations of existing links. This is a database ordering guarantee,
not a guarantee about HTTP response arrival order.

### Medium: Define Wallet Migration Rollback After New Audit Events

`20260831010000_add_wallet_change_requests.ts:117-150` restores an audit
constraint that rejects the newly supported event types. Once such audit events
exist, rollback fails. Define and document a safe irreversible boundary or a
history-preserving supported rollback procedure. Test rollback with each new
event type and verify that failure leaves the schema and audit history intact.
Do not erase security events to make `db:migrate:down` succeed, and do not rewrite
already-applied migration history casually.

## Task B: Durable Operational Alerts

Task B is committed and pushed as `dc57f96`. It is a message-only replacement
for `d411a25` with the exact same patch. Machine commitlint passes, its header is
within 50 characters, every body line is at most 72 characters, and it has no
co-author trailer. The outbox, transactional
producers, leased PostgreSQL dispatcher, authenticated webhook adapter,
environment modes, startup wiring, migration boundary, operator documentation,
and focused tests are accepted. The follow-up makes failed/exhausted replay
constraint-valid and eligible while preserving identity and payload, proves
redelivery through the dispatcher, exhausts pending rows made ineligible by a
lower configured maximum in bounded batches, and reports backlog creation age
separately from due, lease, and terminal timestamps.

Independent source verification passed `pnpm check` with 148 tests in 13 files,
`pnpm test:postgres` with 17 tests in four files, the focused 12-test alert suite,
`pnpm build`, formatting, and the tracked diff check. No source correction
remains in the outbox, producer, dispatcher, or webhook-adapter behavior. The
separate HTTP logging correction below was observable only during live staging.

Controlled staging proof passed in Railway project `earnest-strength`,
environment `staging`. The authenticated receiver is
`https://senda-alert-receiver-staging.up.railway.app/operator-alerts`; its token
and the API authentication secret were generated directly into staging
variables and were not recorded here. Final receiver deployment `2d1581cf`
reached `SUCCESS` with start command `node server.mjs`, `/health`, a 30-second
health timeout, and an on-failure restart policy capped at three retries.

The API service now uses Railway-managed lifecycle settings: the repository
Dockerfile, pre-deploy command `node dist/src/lib/migrate.js up`, start command
`node dist/src/server.js`, `/api/health`, a 100-second health timeout, and the
same capped restart policy. Disposable deployment `6269b04c` proved that exact
production image and lifecycle against an empty database. All 14 migrations
completed through `20260908010000_add_operational_alert_outbox` before the API
became healthy. The temporary service, proof database, and database TCP proxy
were removed. Final source deployment `e8acc407` and post-secret-rotation
redeploy `41606ab4` reached `SUCCESS` with the same configuration.

This is a merchant-wallet smoke flow, not a customer payment flow. It returned
HTTP 201 for merchant registration, HTTP 200 for initial receiving-wallet
configuration, and HTTP 202 for the replacement request. Delivery
`13a409de-3b41-42fe-9e4b-d3156e54d3f6` arrived as version 1 kind
`merchant.receiving_wallet_change_requested`, with valid bearer authentication,
valid delivery-ID idempotency, and only `merchantId` and
`walletChangeRequestId` in the subject. Its durable row reached `delivered` in
one attempt with HTTP 202, a non-null delivery timestamp, and an unchanged
payload delivery identity. Temporary staging database public endpoints were
removed after verification.

After the lifecycle corrections and final service uploads, the same status flow
passed again. Delivery `751835dd-0485-42f9-a7ba-b79106563871` was delivered by
the API and accepted by the receiver with valid authentication, idempotency,
version, event kind, and exact subject keys. That live check also showed that
the API's `pino-http` output included request `cookie` and response `set-cookie`
headers. The staging authentication secret was rotated afterward to invalidate
the observed session, and API deployment `41606ab4` passed Railway health. Do
not run another authenticated staging smoke test until logging is corrected.

### Development Task C1: Redact HTTP Credentials — Accepted

Live staging proved that `pinoHttp({ logger, ... })` currently serializes full
request and response headers. Configure structural redaction for at least
request cookies, authorization, response `set-cookie`, and any other
credential-bearing header used by this service. Add a focused regression test
with sentinel values that proves secrets are absent from serialized output
while method, path, status, timing, and request correlation remain useful. Do
not weaken operational logging or rely on manual cleanup after emission.

Make this a separate conventional commit named
`fix: redact secrets from HTTP logs`. Follow `docs/commit-spec.md`: header at
most 50 characters, every body line at most 72, explain why and what changed,
omit co-author trailers, and stage only the product and test files for this fix.
Do not amend or rewrite accepted Task B commit `dc57f96`.

Acceptance requires all of the following:

1. Structurally redact at least request `cookie`, request `authorization`, and
   response `set-cookie` values before serialization. Cover any additional
   credential-bearing headers used by the application. Do not disable useful
   request logging or depend on Railway to clean emitted logs afterward.
2. Add focused tests using unmistakable sentinel values. Assert that no secret
   value appears anywhere in serialized output while method, path, response
   status, timing, and request correlation remain available.
3. Keep request and response bodies out of routine logs. Check error paths as
   well as successful authenticated requests.
4. Run `pnpm check`, `pnpm build`, and `git diff --check`. Return the commit hash,
   full 50/72-compliant message, files changed, focused-test evidence, and any
   remaining limitation to the reviewer.

Commit `7186b7b` passed final review on 2026-09-09 with no material findings.
The focused two tests, `pnpm check` with 150 tests in 14 files, `pnpm build`,
`git diff --check`, machine commitlint, and the manual 50/72 message check
passed. Staging deployment `4dde42cf-1635-4ebc-bd4f-a3541fa9eea9` reached
`SUCCESS`, and `/api/health` returned the expected healthy response.

### Operations Task C2: Prove Direct Grafana IRM Delivery — Accepted

Use Grafana Cloud as Senda's alert destination without adding another
production service. This is reviewer/operator work and produces no development
commit.

Required proof:

1. In Grafana Cloud, create a raw **Webhook** integration named
   **Senda Operations** under **Alerts & IRM → IRM → Integrations → Monitoring
   systems**. Do not choose Formatted Webhook: Senda already sends a versioned
   JSON body.
2. Require a Grafana service-account bearer token for the integration. Treat the
   webhook URL and token as secrets. Do not paste either value into chat, source
   control, screenshots, logs, or this document.
3. Store the Grafana URL and token only in the staging `senda-api` Railway
   variables `OPERATIONAL_ALERT_WEBHOOK_URL` and
   `OPERATIONAL_ALERT_WEBHOOK_TOKEN`. Point the API directly to Grafana.
4. Keep the existing controlled staging receiver unchanged until the direct
   proof passes. It remains useful evidence of Senda's delivery behavior, but it
   is not part of the intended production path.
5. After Task C1 is accepted and deployed, trigger one harmless merchant-wallet
   replacement alert. Verify Grafana receives the event kind, delivery ID, and
   exact allowlisted subject fields; groups retries under one alert; sends the
   configured human notification; and leaves the durable database row in
   `delivered` state.
6. Record only sanitized evidence: integration name, Railway deployment ID,
   event kind, delivery ID, final status, and notification result. Provider
   acceptance and human acknowledgement are different facts; record both when
   available.
7. If direct delivery passes, do not build or provision a production receiver.
   If it fails, record the sanitized HTTP or payload reason before assigning a
   separate translation-service task. Do not assume such a service is needed.

Direct intake passed on 2026-09-09. Staging deployment
`d84658d8-3b05-4163-abce-80d86f455889` was healthy, and delivery
`5b28ee4d-37fd-4d96-b4be-65eb2ec07b45` reached Grafana alert group #3 in one
attempt. The group showed version 1, the correct event kind, and only
`merchantId` and `walletChangeRequestId` in `subject`; the operator acknowledged
it. The operator then set the grouping ID template to
`{{ payload.deliveryId }}` and assigned **Senda Operator Notification** to the
default route. Final delivery `80be213c-c38a-41ea-aefc-5f9e39133cbb` was
accepted in one attempt, and its automatic email reached the operator. C2 is
accepted with the complete integration → grouping → route → escalation → email
path verified. It produces no code commit, and production does not need a
receiver service.

### Development Task C3: Track Railway Configuration

After C1 and the direct Grafana proof pass, replace stale `railway.json` with
Railway Infrastructure as Code in `.railway/railway.ts`. Use Railway CLI 5.49.1
or newer and the dry-run migration/import workflow. Model the existing staging
API and PostgreSQL relationship without putting Railway UUIDs, generated
domains, plaintext secrets, or database credentials in source.

The tracked configuration must preserve:

- the API Dockerfile, compiled migration and start commands, `/api/health`,
  health timeout, one replica, disabled sleeping, and capped restart policy;
- the existing `OPERATIONAL_ALERT_WEBHOOK_URL` and
  `OPERATIONAL_ALERT_WEBHOOK_TOKEN` variable names as preserved secrets for the
  direct Grafana connection;
- the private `DATABASE_URL` service reference and all existing secret values;
- the existing production PostgreSQL service and volume without recreation,
  deletion, or credential replacement;
- the controlled receiver as a staging-only test service unless its removal is
  separately authorized. Do not make it a production dependency.

Run `railway config plan` and return the redacted plan for review. Do not run
`railway config apply`, `config migrate --apply`, or any destructive option; the
reviewer/operator owns Railway application after inspecting the exact plan.
Resolve dual ownership so the final reviewed change does not leave both legacy
Config as Code and IaC managing the same service. Commit the source-only result
as `ci: track Railway service configuration`, following the 50/72 and
no-co-author requirements. Return the plan, commit hash, full message, and exact
verification results.

The configured staging deployment path is corrected and proven. C3 replaces
the deprecated `railway.json` and its runtime-incompatible `pnpm db:migrate`
command with Railway's supported project-level configuration. Do not use a
public database proxy as the normal deployment path.

Reviewer result on 2026-09-09: the C3 source and independent staging and
production plans pass. Staging reports zero additions, three harmless setting
updates, and zero destructions. Production reports only the expected API
addition, with no PostgreSQL, volume, receiver, or destructive operation. The
live service configuration has no explicit legacy `configFile` field. Nothing
was applied. Commit `7fa3136` contains exactly the six reviewed product files;
its final message passes machine commitlint and the manual 50/72 check with no
co-author trailer. C3 is accepted and pushed. A fresh production plan after
Railway reauthentication still reports only the expected API addition, with
zero changes and zero destructions. The separately authorized production
rollout remains.

### Production Grafana Destination and Token

Grafana provides two private values for the direct connection: an incoming
webhook URL and a service-account token. The user does not invent either value
or paste it into chat. The reviewer/operator enters them directly in the
production API's `OPERATIONAL_ALERT_WEBHOOK_URL` and
`OPERATIONAL_ALERT_WEBHOOK_TOKEN` Railway variables.

Production currently contains PostgreSQL but no API service, so the destination
cannot be configured until that rollout is authorized. Create a separate
**Senda Production** Grafana integration and production-only token; do not reuse
staging credentials. If the staging direct-delivery proof passes, production
does not need an alert receiver service. Record only non-secret service
identities and sanitized verification here.

The production PostgreSQL credential was regenerated through Railway and the
database was redeployed on 2026-09-09. Deployment `f558ee42` reached `SUCCESS`,
the existing volume remained `READY`, and a read-only `SELECT 1` over Railway
SSH returned `1` using the regenerated `DATABASE_URL`. The replacement value
was not printed or recorded. This closes the production database credential
gate.

The operator then created the separate **Senda Production** raw Webhook
integration with a production-only Grafana service-account token, grouping by
`deliveryId`, and the existing **Senda Operator Notification** escalation chain.
The private endpoint and token were not recorded. Live delivery remains to be
verified after the production API is deployed.

The exact authorized production plan of one addition, zero changes, and zero
destructions was saved and applied. It created only the empty production
`senda-api` service; PostgreSQL and its volume remained healthy, and no code was
deployed. The post-creation plan contains one remaining non-destructive update
to set the API restart policy to `ON_FAILURE` and disable sleeping. The operator
authorized and applied that exact follow-up plan. Railway accepted it, but the
stored service configuration still omits both fields and a fresh plan proposes
the same update. No repeated apply was attempted. Keep the reviewed IaC as the
source of truth; after the first API deployment, plan again and apply only if
the same non-destructive update remains, then verify the read-back.

The production API now has the active Railway domain
`https://senda-api-production.up.railway.app`. The reviewer added the known
production settings and generated a fresh `BETTER_AUTH_SECRET` directly into
Railway with deployment disabled; no secret value was printed. The database
reference is present. The operator copied the two **Senda Production** Grafana
values privately into Railway.

Accepted commit `7fa3136` was packaged without the untracked reviewer documents
and deployed. Deployment `adad5bc8-aebb-46cd-8fc2-6bdc4a56c1dd` reached
`SUCCESS`, `/api/health` returned the expected response, and the effective
deployment manifest shows `ON_FAILURE`, three retries, and serverless sleeping
disabled. Production remains unlinked from GitHub so a push cannot bypass the
explicit review and release checkpoint.

Do not apply the current Railway plan. C4 now preserves `BASE_RPC_URL` and
`TRUST_PROXY_HOPS`, so independently reproduced plans no longer propose deleting
them. Railway still reports known configuration drift even though the effective
production deployment already has the accepted settings. Direct production
alert delivery, human notification, and the initial external uptime-monitoring
check pass.

The production alert proof used one dedicated test merchant and dummy wallet
addresses. The replacement request returned 202 and delivery `d00f0033` reached
Grafana in one attempt with HTTP 200. The request was then cancelled through
Senda's audited application service, preventing later activation; cancellation
delivery `caf7d8ce` also reached Grafana in one attempt with HTTP 200. The test
cookie was deleted, and no credential or wallet value was recorded.

The operator confirmed the production notifications arrived. Grafana synthetic
check **senda-api-production** requests the production `/api/health` endpoint
every minute and reports 100% uptime and reachability in its initial observation
window. Do not interpret the short initial window as long-term availability.

### Development Task C4: Complete

The implementation adds only `preserve()` entries for `BASE_RPC_URL` and
`TRUST_PROXY_HOPS` in the shared API environment. It does not inline their
values, touch Railway secrets, change the live service, or remove the reviewed
restart and no-sleep policy.

Independent review passed `pnpm check` with 150 tests in 14 files, `pnpm build`,
both diff checks, machine commitlint, and the manual 50/72 message check. The
production plan is zero additions, one change, and zero destructions; it shows
only Railway's persistent lifecycle reporting diff. The staging plan is zero
additions, three changes, and zero destructions; it shows the known build and
lifecycle diffs. Neither plan deletes the two runtime variables or changes
PostgreSQL, its volume, domains, secrets, topology, or the staging-only receiver.
Nothing was applied.

Commit `fa1b3d6` contains only `.railway/railway.ts`, follows the commit spec,
and has no co-author trailer. All untracked reviewer documents and handoffs
remained outside the commit. Do not apply a plan or redeploy for this source-only
guard. Its accepted message is:

```text
ci: preserve Railway runtime variables

Preserve the Base RPC and trusted-proxy settings in project-level
Railway configuration so production plans cannot remove valid runtime
values.

Retain the reviewed lifecycle policy. Verify redacted staging and
production plans without applying the persistent Railway default-value
drift.
```

### Required Behavior

1. Enqueue one alert for each new wallet replacement request, merchant or system
   cancellation, successful application, and paid-payment reorg detection.
   Application also emits `merchant.receiving_wallet_changed`; do not send a
   second application alert for that compatibility event. No-op or replayed
   transitions must not enqueue duplicates.
2. Persist the domain transition, its audit event, and the outbox row in the
   same database transaction. Enqueue failure rolls everything back. Delivery
   failure after commit leaves the domain transition intact and retryable
   delivery work durable.
3. Use a stable event/delivery identifier and a database uniqueness constraint.
   Define a versioned, allowlisted payload, event time, event kind, and safe
   subject identifiers. Never include passwords, session cookies, credentials,
   or raw provider responses. Record wallet request correlation where needed
   without changing public API privacy boundaries.
4. Claim a bounded batch with database-backed concurrency control and a
   recoverable lease. Use the database clock for scheduling and lease expiry.
   Do not hold a database transaction or row lock during an external request.
   A worker whose lease has expired must not overwrite a newer claim's result.
5. Deliver with a finite timeout. Define retryable failures, capped backoff,
   maximum attempts, and durable exhausted/failed state. Restarting a worker
   must recover pending and abandoned work. One failing destination or row must
   not prevent other due rows from being processed.
6. Describe delivery honestly as at least once: a crash after external acceptance
   but before local acknowledgement can redeliver. Send the stable identifier
   so the receiver can deduplicate. Do not claim exactly-once network delivery.
7. Configure the destination and credentials only on the server. Document
   disabled, missing-config, and production modes. For a webhook, use an
   operator-configured destination and authenticated requests; do not derive
   its URL from merchant or public request input. Tests use a controlled fake
   receiver and must not contact real recipients.
8. Add a forward migration with state/timestamp consistency checks, unique
   delivery identity, and indexes for due work and expired leases. Preserve
   audit history and document rollback limitations. Define an explicit cutover
   for pre-existing audit events; do not silently deliver all historical events.
9. Wire startup and worker lifecycle, structured redacted logging, and an
   operator procedure to inspect backlog age, retries, exhausted deliveries,
   and worker availability. Document safe replay using the original delivery
   identity. Do not rely only on the failed channel to reveal its own outage.

### Acceptance Evidence

Build a criterion-to-file-to-test matrix before editing. Cover each event
producer, no-ops and duplicate calls, enqueue rollback, delivery failure without
domain rollback, independent workers, stale lease ownership, restart recovery,
timeout/backoff/exhaustion, poison-row isolation, and the crash-after-send case.
Exercise the actual dispatcher entry point and migration constraints/indexes.

Run `pnpm check`, `pnpm build`, `git diff --check`, and the separate PostgreSQL
integration tests. Have a read-only Sol reviewer at high effort compare the
original task, complete diff, and evidence before marking it complete. Document
the selected adapter's contract and a controlled delivery smoke-test result.

Email campaigns, arbitrary merchant webhooks, paging integrations, two-factor
authentication, signatures proving merchant wallet ownership, refunds, and reorg
compensation remain outside this task.

## Release and Operations Gates

- Rehearse `20260825010000_repair_payment_intent_merchant_ownership.ts` on a
  recent staging clone before production: preserve legacy payment intents,
  inspect placeholder merchant records, and verify the restored foreign key.
- Rehearse case-insensitive wallet normalization against existing data. Resolve
  collisions explicitly; never delete a merchant to make migration pass.
- Record deployment topology and trusted proxy configuration. The present
  in-memory limiter supports one API process; multiple instances require a
  shared limiter before rollout. Multi-worker database safety does not remove
  this separate rate-limit restriction.
- Keep paid status terminal and 12 confirmations unchanged. Bound historical
  paid polling and define escalation for prolonged receipt absence before
  larger volume, as already recorded in the review. This scale work is not a
  reason to silently change payment acceptance policy.
- Store sanitized migration and delivery verification results with the handoff.
  Local tests do not establish Railway production-data safety or live delivery.
- The supported Railway service configuration has been proven to run all 14
  migrations from the production image before API startup on a fresh database.
  Preserve that lifecycle for production.
- Replace deprecated `railway.json` with supported tracked configuration before
  2026-12-01 so a recreated service receives the proven lifecycle without
  manual drift.
- Redact credential-bearing HTTP headers and prove the redaction in tests before
  another authenticated staging smoke test or any production deployment.
- Rotate the production PostgreSQL credential that appeared in diagnostic
  output during this staging setup before production use, then update every
  authorized consumer without recording the old or replacement value here.

## Sequence After Backend Acceptance

Only `main` exists locally at this baseline. The following are planned branch
roles, not branches already created or merged. Finish backend findings and
alerting before beginning this sequence, as required by the review.

1. **`flow`: customer-flow backend.** Follow
   `docs/customer-payment-flow-plan.md`. Start with the disposable Turnkey proof
   of concept before production schema. Prove customer-only signing, exact
   direct Base EOA transfer compatibility, target Nigerian Android passkey and
   recovery behavior, provider exit, and recoverable outages. Do not replace
   missing evidence with SDK assumptions.
2. Implement the customer identity boundary, wallet persistence/provisioning,
   device and recovery lifecycle, balances, customer-bound checkout, signing
   boundary, and operational hardening in the plan's work-package order. Settle
   identity roles and legacy-unbound-link policy before their migrations.
   Merchant authentication currently treats an auth user as a merchant; explicit
   authorization isolation must land before customer accounts are enabled.
3. Clarify repeated Pay behavior in the provider proof: backend transaction-hash
   uniqueness prevents duplicate association but cannot stop a customer signing
   and broadcasting two separate transfers. Require demonstrated coordination
   across retries, reloads, and devices before claiming duplicate payment
   prevention. Never retry signing merely because hash submission timed out.
4. **`app`: frontend.** Follow `docs/frontend-plan.md` for same-origin scaffold,
   shared contracts, merchant UI, public details and receipts, then customer
   account/wallet and Pay integration after verified `flow` contracts are
   merged. Preserve the chosen no-connect Turnkey EOA experience, explicit
   per-payment approval, and USDC plus Base ETH funding model.

For every development handoff, return the commit, requirement matrix, changed
contracts, migration notes, exact checks, and unresolved findings to the planner.
Delegate the read-only implementation review to Sol at high effort; keep
development and final acceptance separate. No task is complete solely because
the test count increased.
