# Review: Senda MVP Backend Changes

Review snapshot: 2026-09-09. Task B's commit message, controlled staging
delivery, and Railway-managed migration lifecycle are accepted. Live staging
verification exposed one HTTP-log redaction correction. C1 is accepted as
commit `7186b7b` and deployed successfully to staging as `4dde42cf`. Grafana
Cloud IRM is the selected human-notification target. Direct API-to-Grafana
delivery passes in staging, including grouping, escalation, and email
notification. C3 is accepted and pushed as `7fa3136`. The reviewed backend is
deployed to production as `adad5bc8`, its public health check passes, and its
effective lifecycle settings match C3. C4 is accepted as `fa1b3d6`; it preserves
the two valid runtime variables for future plans and requires no deployment.
Earlier commit reviews are historical findings. The current acceptance status
and next work are recorded below and in
[`docs/backend-completion-handoff.md`](docs/backend-completion-handoff.md).

## Current Disposition

Task A is accepted and committed as `88618ff`. Its full message satisfies the
repository's manual 50/72 requirements.

Task A2 is fully accepted:

- `b2145e9` keeps timed-out transaction hashes recoverable, persists an
  immutable monitoring timeline, exposes it in the public contract, continues
  worker reconciliation for 24 hours, preserves manual recovery after persisted
  escalation, and retains exact receipt and transfer-log verification;
- `703a9c4` serializes payment-link creation and wallet activation on the
  merchant lock, takes database time after lock acquisition, and proves both
  database orderings with independent PostgreSQL sessions;
- `e006bbf` adds a history-preserving wallet rollback boundary, documents the
  supported application-only rollback, and proves all protected event types and
  both writer/rollback orderings.

No source-code correction was found. `pnpm check` passed with 122 tests in nine
files; `pnpm test:postgres` passed with 14 tests in three files against
PostgreSQL; `pnpm build`, `git diff --check 88618ff..HEAD`, and machine
commitlint also passed.

The message-only amendments replaced `e4506dd`, `1fd6388`, and `17aa395` with
the hashes above. Each replacement has the exact same Git tree as its
predecessor. All headers remain within 50 characters, every body line is now at
or below 72, and machine commitlint reports zero problems. Task B followed this
accepted baseline.

Task B's message-only amend is accepted and pushed as `dc57f96`. It has the
exact same patch as `d411a25`, machine commitlint passes, the 40-character
header is within 50, every body line is at most 72 characters, and there is no
co-author trailer.

The Railway migration path and its tracked replacement are accepted. The API
runs `node dist/src/lib/migrate.js up` from the production image before
`node dist/src/server.js`; a disposable fresh database proved all 14 migrations
complete before application health succeeds. C3 replaces the deprecated
`railway.json` with the project-level `.railway/railway.ts` configuration.

The C1 implementation and standalone commit `7186b7b` passed review on
2026-09-09 with no material findings. `src/lib/logger.ts` structurally removes
the complete request and response header objects, and `src/app.ts` exposes the
same production middleware for controlled testing. `src/lib/logger.test.ts`
proves that credential and body sentinels are absent on success and error paths
while request ID, method, URL, status, response time, and remote address remain.
The focused two-test run, `pnpm check` with 150 tests in 14 files, `pnpm build`,
`git diff --check`, machine commitlint, and the manual 50/72 message check
passed. Staging deployment `4dde42cf-1635-4ebc-bd4f-a3541fa9eea9` reached
`SUCCESS`, and `/api/health` returned the expected healthy response.

The production PostgreSQL credential rotation is accepted. The separate
**Senda Production** Grafana integration and token are configured privately.
The production API is online and healthy. Direct production delivery to Grafana
and the operator notifications pass. The new one-minute production synthetic
check reports 100% uptime and reachability in its initial observation window.
Do not record any secret value in this file.

### Remaining Backend and Operations Tasks

The detailed requirements and evidence checklist are in
`docs/backend-completion-handoff.md`. Complete the development commits and the
operator-owned Grafana proof in this order:

1. **C1 — HTTP credential redaction:** accepted as `7186b7b` and deployed to
   staging as `4dde42cf`. No further C1 development action remains.
2. **C2 — Direct Grafana staging proof:** accepted. Direct intake passes through
   the secured **Senda Operations** raw Webhook integration, grouping uses
   `{{ payload.deliveryId }}`, the default route triggers **Senda Operator
   Notification**, and the final alert produced the expected email. This
   operator task produces no code commit.
3. **C3 — Railway IaC:** accepted and pushed as `7fa3136`. Its six-file scope,
   final message, and both read-only environment plans pass review. The accepted
   backend is deployed successfully to production as `adad5bc8`.
4. **C4 — Preserve Railway runtime variables:** accepted and committed as
   `fa1b3d6`. Its only file, `.railway/railway.ts`, adds `preserve()` entries for
   `BASE_RPC_URL` and `TRUST_PROXY_HOPS`. Independent production and staging
   plans contain no variable deletion. Neither plan was applied.

Independent C4 verification passed `pnpm check` with 150 tests in 14 files,
`pnpm build`, both diff checks, machine commitlint, and the manual 50/72 message
check. The production plan reports zero additions, one change, and zero
destructions: only Railway's known null-versus-effective lifecycle diff. The
staging plan reports zero additions, three changes, and zero destructions: its
known build and lifecycle diffs. Neither plan changes PostgreSQL, its volume,
domains, secrets, topology, or the staging-only receiver.

The C4 commit follows `docs/commit-spec.md`: one coherent outcome, a 38-character
header, body lines no longer than 70 characters, and no co-author trailer. No
reviewer document or handoff was included. Do not apply a Railway plan or
redeploy for C4; this source-only guard prevents a future plan from deleting
valid runtime values.

### Task B Commit and Staging Review

The Task B tree committed on 2026-09-08 implements the intended durable outbox
and authenticated webhook architecture. It covers every requested producer,
keeps domain state, audit, and enqueue in one transaction, uses a stable
allowlisted payload, claims bounded PostgreSQL batches with recoverable leases,
fences stale results, implements finite delivery timeouts and capped
retry/exhaustion, starts the dispatcher with the server, and documents cutover
and rollback boundaries.

Independent verification passed:

- `pnpm check`: 146 tests in 13 files, including typecheck, lint, and formatting;
- `pnpm test:postgres`: 17 tests in four files;
- `pnpm build` and the tracked `git diff --check`.

The 2026-09-08 follow-up resolves both findings:

1. Failed/exhausted replay now resets the attempt and state fields atomically,
   preserves the original delivery ID and payload, and is proven through the
   actual dispatcher. Pending work at or above a newly lowered maximum moves to
   durable `exhausted` state in bounded batches instead of becoming stranded.
2. The operator query now reports oldest `createdAt` and its age separately from
   next-due, lease-expiry, and terminal timestamps.

The reviewer reran the focused 12-test alert suite and `pnpm build`, then the
full `pnpm check`: 148 tests in 13 files with typecheck, lint, and formatting.
The PostgreSQL suite passed 17 tests in four files, and the tracked diff check
remains clean. No outbox, producer, dispatcher, or webhook-adapter behavior
finding remains. The separate HTTP logging correction below was discovered only
during live staging.

The controlled Railway staging proof used project `earnest-strength`,
environment `staging`, API service `senda-api`, and receiver service
`senda-alert-receiver`. The receiver identity was
`https://senda-alert-receiver-staging.up.railway.app/operator-alerts`; its bearer
token and the API authentication secret were generated and stored only as
staging variables. Final receiver deployment `2d1581cf` reached `SUCCESS` with
`node server.mjs`, `/health`, a 30-second health timeout, and an on-failure
restart policy capped at three retries.

The API's Railway-managed service configuration uses the repository Dockerfile,
pre-deploy command `node dist/src/lib/migrate.js up`, start command
`node dist/src/server.js`, `/api/health`, a 100-second health timeout, and the
same capped restart policy. Disposable deployment `6269b04c` proved that exact
configuration against an empty database: all 14 migrations completed through
`20260908010000_add_operational_alert_outbox`, then the API became healthy. The
temporary proof service, proof database, and database TCP proxy were removed.
Final uploaded API deployment `e8acc407` and the post-secret-rotation redeploy
`41606ab4` both reached `SUCCESS` with that lifecycle.

This is a merchant-wallet smoke flow, not a customer payment flow. It registered
a merchant with HTTP 201, configured the first receiving wallet with HTTP 200,
and requested a replacement with HTTP 202. The original proof delivery
`13a409de-3b41-42fe-9e4b-d3156e54d3f6` reached durable `delivered` state in one
attempt with HTTP 202 and matching payload identity. After the lifecycle fixes
and final uploads, delivery `751835dd-0485-42f9-a7ba-b79106563871` was delivered
by the API and accepted by the receiver as version 1 kind
`merchant.receiving_wallet_change_requested`, with valid authentication,
idempotency, and exactly `merchantId` and `walletChangeRequestId` subject keys.

The live check also exposed session-cookie values in API logs. The staging
authentication secret was rotated afterward, invalidating the observed staging
session, and deployment `41606ab4` passed Railway health. C1 later corrected the
logging issue and cleared the authenticated-smoke restriction.

This closes the migration and controlled receiver gates. The controlled
receiver validates and logs alerts; it does not notify a human and is no longer
part of the intended production path. Direct Grafana IRM intake and automatic
email notification now pass. Production credentials must be entered directly
in Grafana and Railway and must never be committed, pasted into planner
documents, or returned in review output.

### C2 Direct Grafana Staging Review

Staging API deployment `d84658d8-3b05-4163-abce-80d86f455889` reached
`SUCCESS` after the operator stored the Grafana webhook URL and service-account
token directly in Railway. A sanitized variable check confirmed webhook mode,
an HTTPS Grafana incident host, and a configured token without printing either
private value. `/api/health` returned the expected healthy response.

The safe merchant flow returned HTTP 201 for registration, HTTP 200 for initial
wallet setup, and HTTP 202 for the delayed replacement request. Delivery
`5b28ee4d-37fd-4d96-b4be-65eb2ec07b45` was accepted in one attempt as
`merchant.receiving_wallet_change_requested`. Grafana created alert group #3
under **Senda Operations** with version 1 and exactly `merchantId` and
`walletChangeRequestId` in `subject`; the operator acknowledged the group.

The first screenshot also showed `alert group assigned to route "default" with
no escalation chain, skipping escalation`. The operator then set the grouping
template to `{{ payload.deliveryId }}` and assigned **Senda Operator
Notification** to the default route. Final controlled delivery
`80be213c-c38a-41ea-aefc-5f9e39133cbb` was accepted in one attempt as the same
wallet-request event kind, and the operator received the resulting email. C2 is
accepted. The complete verified flow is API outbox → secured Grafana integration
→ grouping → default route → escalation chain → email. Do not add a production
receiver.

### C3 Railway IaC Review — Accepted

The source change correctly replaces `railway.json` with the single supported
`.railway/railway.ts` entry point. It preserves the compiled migration and API
start commands, Dockerfile build, health check, single `ams` replica, disabled
sleeping, capped restart policy, private `DATABASE_URL` reference, and existing
secret variable names. The controlled receiver is present only in `staging`.
No Railway UUID, generated domain, plaintext secret, or database credential is
present in the tracked configuration.

Independent Railway CLI 5.49.6 plans were run without apply. The staging plan
contains zero additions, three setting updates, and zero destructions. The
updates only make the API Dockerfile builder and the API and receiver restart
and sleep settings explicit. The production plan contains one addition, the
expected `senda-api` service, with zero updates and zero destructions. It does
not create, modify, detach, replace, or destroy the existing PostgreSQL service
or `postgres-volume`, and it does not add the staging receiver. A sanitized live
configuration check also found no remaining remote `configFile` field, so
deleting `railway.json` does not leave explicit legacy-file ownership behind.

The source changes, `pnpm check`, `pnpm build`, formatting, lint, typecheck,
tests, `git diff --check`, and machine commitlint pass. Commit `7fa3136` contains
the corrected 50/72-compliant message:

```text
ci: track Railway service configuration

Replace the stale per-service file with Railway's project-level
TypeScript configuration. Preserve the proven API lifecycle, private
Postgres reference, secret variables, single-replica policy, and
the existing production database volume.

Keep the controlled alert receiver limited to staging. Add the Railway
SDK for local planning and verify the redacted plan without applying
infrastructure changes.
```

The pushed commit contains exactly `.railway/railway.ts`, `README.md`,
`eslint.config.js`, `package.json`, `pnpm-lock.yaml`, and the `railway.json`
deletion. The review documents, analysis files, and
`task-c3-review-handoff.md` remain untracked and outside the commit. No
co-author trailer is present.

A fresh production readiness check after Railway reauthentication confirmed
that production still contains only the healthy PostgreSQL service and its
ready 500 MB `postgres-volume`. The pushed C3 configuration still plans exactly
one addition, `senda-api`, with zero changes and zero destructions. Applying
that plan remains unauthorized until the production Grafana setup is complete.

The operator regenerated the production PostgreSQL password with Railway's
database action and redeployed it. Deployment `f558ee42` reached `SUCCESS`, the
existing `postgres-volume` remained `READY`, and an SSH-authenticated read-only
`SELECT 1` returned `1` through the regenerated `DATABASE_URL`. No credential
value was printed or recorded. The production database credential gate is
closed.

The operator created the separate **Senda Production** raw Webhook integration,
required a production-only Grafana service-account token, set grouping by
`deliveryId`, and selected **Senda Operator Notification** on the default route.
The endpoint and token remain private. This production path still requires an
end-to-end delivery test after the API is deployed.

The operator authorized the exact production Railway plan of one addition,
zero changes, and zero destructions. A pinned plan was applied and created only
the empty `senda-api` service. PostgreSQL stayed `SUCCESS`, and
`postgres-volume` stayed `READY`.

The operator separately authorized and applied the exact follow-up plan of zero
additions, one non-destructive service update, and zero destructions. Railway
accepted the apply, but a read-back still omits `restartPolicyType` and
`sleepApplication`, and a new plan still proposes those same two fields. The
reviewer did not loop another apply. Keep `.railway/railway.ts` as the source of
truth, deploy the service once after its private variables are configured, then
plan, apply if still needed, and verify both settings from Railway.

The production API now has the active Railway domain
`https://senda-api-production.up.railway.app`. Before deployment, the reviewer
set `NODE_ENV`, `BETTER_AUTH_URL`, `BASE_RPC_URL`, `TRUST_PROXY_HOPS`, and
`OPERATIONAL_ALERTS_MODE`, and generated a new production-only
`BETTER_AUTH_SECRET` directly into Railway without displaying it. `DATABASE_URL`
remains the private Postgres reference. The operator added the private **Senda
Production** Grafana webhook URL and service-account token directly in Railway.

Accepted commit `7fa3136` was archived separately from the untracked reviewer
documents and uploaded to production. Deployment
`adad5bc8-aebb-46cd-8fc2-6bdc4a56c1dd` reached `SUCCESS`; the public
`/api/health` endpoint returned the expected healthy response. Its effective
manifest uses the compiled migration and start commands, one `ams` replica,
restart on failure capped at three attempts, and disabled serverless sleeping.

A dedicated production test merchant requested a dummy receiving-wallet change.
The API returned 202 with a pending request, and delivery
`d00f0033-cca9-44d7-85f3-ff0d7007d3d3` reached Grafana in one attempt with
HTTP 200. The original test session then exceeded the five-minute freshness
window, so its public cancellation correctly returned 403. The reviewer used
Senda's own transactional cancellation function inside the API container,
rather than editing PostgreSQL directly. The request became `cancelled`, and
delivery `caf7d8ce-47e6-4b71-85fc-5aebbd56661c` also reached Grafana in one
attempt with HTTP 200. No wallet change will activate later. The temporary
cookie was deleted, and no password, cookie, wallet address, webhook URL, or
token was recorded. The operator confirmed the resulting notifications arrived.

Grafana synthetic check **senda-api-production** now requests
`https://senda-api-production.up.railway.app/api/health` every minute. Its
initial dashboard reports 100% uptime and reachability. This is the required
external availability signal; the short initial window is not a long-term
reliability claim.

The pre-C4 Railway plan was not safe to apply because C3 did not preserve the
valid `BASE_RPC_URL` and `TRUST_PROXY_HOPS` variables. C4 corrects that source
configuration, and fresh independent staging and production plans no longer
propose either deletion. Do not apply those review plans: Railway still reports
known build or null-versus-effective lifecycle differences. Keep production
deployment manual for now; connecting the repository to automatic production
deploys would bypass the explicit review and release checkpoint.

## What “One Receiving Wallet Per Merchant” Means

Each merchant account has one configured blockchain address that receives its
payments. It is not one wallet shared by every Senda merchant.

When a merchant creates a payment link, Senda reads the merchant's configured
address and stores it as the payment destination. The client does not choose
the destination address for each link.

This keeps the MVP narrow and predictable:

- one business account maps to one receiving address;
- all of that merchant's payment links use that address;
- Senda does not pool merchant funds into a platform wallet;
- Senda does not provide per-invoice destination wallets yet;
- changing the address is an account-level operation that should eventually
  have additional authentication, audit, and recovery controls.

Commit `2ef653e` addresses the earlier byte-wise wallet uniqueness gap. It
canonicalizes EVM addresses and adds a forward migration that rejects
case-insensitive collisions before replacing the old index. Production
collisions must be resolved explicitly before deployment; the migration does
not discard either merchant record.

## Review Outcome

The previous review findings are addressed by the current changes:

- A separate forward migration,
  `20260825010000_repair_payment_intent_merchant_ownership.ts`, repairs
  already-applied databases without rewriting migration history.
- Authenticated merchant responses now include the nullable
  `receivingWalletAddress` field, so the current wallet configuration survives
  a frontend reload.
- Payment-link creation still derives its destination from the merchant record,
  and invalid amount or expiry values return HTTP 400.

## Checkout Review

The guided checkout implementation constructs the expected Base USDC transfer
request and now covers the earlier transaction-integrity findings:

- transaction hashes are normalized and protected by case-insensitive
  uniqueness;
- duplicate submissions for one intent are handled idempotently;
- a transaction cannot be reused on another payment link;
- receipt status and confirmation count determine whether a payment is
  `confirming`, `paid`, or `failed`;
- submission retries that race with reconciliation accept the already-`paid`
  intent;
- the RPC provider validates that it is connected to Base before reading
  transaction data;
- a server-side reconciliation worker continues checking confirming intents
  when the customer leaves checkout.

## Confirmation Policy

Senda currently requires 12 Base confirmations, counting the transaction's
inclusion block as the first. This is an explicit operational acceptance
threshold, not a Base technical requirement.

The accompanying `Base-12-confirmations-payment-analysis.md` is advisory
product analysis only. It is not application code and does not affect the test
count. The current implementation remains at 12 confirmations; no faster
confirmation policy has been implemented in these changes.

The Base analysis is directionally correct:

- 12 confirmations is not a fixed 12-second wait;
- with Base blocks around two seconds apart, the chain portion is roughly
  24 seconds after inclusion;
- the 15-second reconciliation interval can add up to another polling interval,
  so the visible transition to `paid` may take roughly 24--39 seconds;
- 12 confirmations is conservative for everyday payments, while 1--3 may be a
  better UX/security balance for low-value payments.

For the MVP, the conservative setting remains defensible. Do not change it as
part of receipt generation. Revisit fast acceptance versus deeper finality only
when merchant risk and payment-value requirements are available.

## Hardening Status

These commits implemented the original checkout hardening subtasks:

- `e7a2839` marks a confirming intent as `dropped` after the configured timeout;
  the late-settlement safety finding below remains open;
- `5263b21` requires the expected successful USDC `Transfer` log before a
  payment can become `paid`;
- `3adc0db` adds terminal paid-payment reorg monitoring and audit fields.

Commit `3adc0db` completes the paid-reorg monitoring subtask. It records `paidAt`,
shares exact transfer-log validation between confirmation and paid monitoring,
and records `reorgDetectedAt` when both transaction and receipt disappear or a
returned receipt has reverted, changed transaction identity, or lost its
expected transfer. A missing receipt alone remains inconclusive while the
transaction is still visible. The conditional database update prevents
concurrent workers from producing duplicate audit transitions, and the
customer-facing status remains `paid`.

`paidIsTerminal` is a policy declaration rather than a runtime feature switch;
the update paths enforce the terminal behavior. Compensation remains out of
scope. External alerting was deferred from that commit and is now required by
the final backend-plan step 7 task below. Before larger payment
volume, also bound how long paid rows are polled and define escalation for a
transaction that remains visible without a receipt for an extended period.

## Receipt Review

Commit `5fed816` completes backend-plan step 6. It provides the canonical
paid-only receipt, settlement-review signal, forward `paidAt` backfill, and
focused API and migration tests. The contract's exported `PaymentReceipt` type
is now reused by the service, so the earlier duplicate-type cleanup is also
complete.

## Rate-Limit Review

Commit `66480e9` completes the route-aware request-limit task. It includes the
operator-facing environment documentation, default IP key validation, standard
and retry headers, proxy-chain regression coverage, independent merchant
budgets, health exclusion, and the single-process store warning.

## Audit-Event Review

Commit `2ef653e` completes the durable audit foundation:

- wallet changes lock the merchant row, canonicalize the address, and append the
  merchant-actor event in the same transaction;
- semantic and concurrent no-op updates do not create events, while concurrent
  real changes preserve the correct old-to-new sequence;
- reorg events include merchant and payment subjects plus one of four explicit
  reason codes;
- actor and subject consistency checks protect the audit schema, and a partial
  unique index enforces one reorg event per payment intent;
- audit insertion failure rolls back the wallet or reorg state update;
- migration coverage proves normalization, collision preservation, and later
  case-insensitive uniqueness;
- public payment and receipt responses do not expose the audit log.

Historical identifiers intentionally remain denormalized so later source-record
deletions cannot erase the identity captured by an event. This is appropriate
for the current append-only operational log.

## Fresh-Authentication Review

Commit `aec03d2` implements the functional Better Auth fresh-session correction;
database-clock hardening remains required by the additional findings below:

- the wallet request remains password-free;
- Better Auth and the application share a configurable five-minute
  `session.freshAge` policy;
- `PUT /api/merchant-wallet` uses a database-backed freshness check and returns
  HTTP 403 for a stale but otherwise valid session;
- the existing sign-in endpoint remains the only password reauthentication path
  and returns a new HTTP-only session cookie;
- stale sessions continue to work for ordinary merchant reads;
- stale attempts do not mutate the wallet or append audit events;
- successful reauthentication followed by retry creates exactly one audited
  wallet change;
- the freshness setting and client behavior are documented.

The wallet service continues to preserve row locking, canonicalization,
case-insensitive uniqueness, and transactional audit insertion.

Commit `8cb28d6` corrected the just-inside-freshness-boundary test name to say
“accepts.” An explicit wrong-password sign-in regression for reauthentication
remains a non-blocking test improvement.

## Implementation Session Protocol

Every development session implementing a task from this review must use the
following protocol. Passing the existing suite is necessary but is not, by
itself, evidence that the task is complete.

Before editing:

1. Read the complete active task, related migrations, services, workers,
   contracts, tests, and frontend contract documentation.
2. Create a requirement matrix mapping every numbered criterion to its intended
   implementation files, proving tests, and important failure or concurrency
   cases.
3. List the invariants that must remain true and choose an enforcement strategy
   for each before implementation begins.

For database-backed workflows, explicitly review:

- whether the database clock is authoritative for security decisions;
- whether every public service function enforces its own timing rules;
- lock acquisition order across all transactions touching the same records;
- idempotency under retries, restarts, and multiple workers;
- cancellation versus worker races;
- uniqueness and reservation races across tables;
- exactly-once state transitions and audit events;
- rollback when any dependent write fails;
- deterministic handling of terminal and conflicting states;
- partial indexes for worker queries;
- migration constraints, existing-data safety, and rollback limitations.

For API changes, explicitly review:

- success status and response shape for every outcome;
- stable 400, 401, 403, 404, 409, and 429 behavior;
- authentication and fresh-session middleware placement;
- whether a response can misrepresent pending, active, or terminal state;
- whether frontend documentation matches exact fields and semantics;
- whether internal IDs, credentials, provider data, or audit records leak.

Testing and completion requirements:

1. Add failing tests for every criterion before or alongside implementation.
2. Cover happy paths, boundary timing, malformed state, duplicates, retries,
   concurrent calls, multiple workers, rollback, and provider or database
   failure where applicable.
3. Test the worker entry point itself, not only the service it calls.
4. Test migration constraints and indexes, not only transformed data.
5. Run narrow tests while iterating, followed by `pnpm check`, `pnpm build`, and
   `git diff --check`.
6. Re-read the task line by line and complete the requirement matrix.
7. Inspect the complete diff for omitted files, unrelated changes, secrets, and
   migration or documentation drift.
8. Launch a read-only reviewer subagent with the original task and ask it to find
   correctness, concurrency, migration, API, security, and test gaps.
9. Fix every material reviewer finding and report any intentionally incomplete
   criterion instead of claiming the task is complete.

For the current wallet-activation task, completion additionally requires tests
proving that:

- a direct call cannot activate before `activationAt`;
- the database clock is authoritative;
- all participating transactions use one consistent lock order;
- initial setup and pending requests cannot claim the same address;
- cancellation and activation have one deterministic winner;
- repeated and multi-worker activation is idempotent;
- an activation conflict reaches a terminal audited state instead of retrying
  forever;
- due-work indexes and timestamp constraints exist;
- frontend wording treats `activationAt` as an eligibility time.

## Backend-Plan Step 7 Status

Implemented foundations:

- route-aware request limits in `66480e9`;
- durable security audit events in `2ef653e`;
- fresh authentication for wallet replacement in `aec03d2`, with the
  database-clock correction still open.

Commit `8cb28d6` implements the delayed wallet request model and adds all four
previously requested proof test groups. This work is committed, not an
uncommitted implementation. Stronger concurrency and rollback evidence is still
required for sign-off, as described below. Durable operational alert delivery
remains the final planned step 7 item afterward.

## Delayed Wallet Replacement Review

Commit `8cb28d6` addresses the original activation design gaps:

- request creation and direct application use the database clock;
- direct calls cannot apply a request before `activationAt`;
- merchant, advisory address, and request locks follow one order;
- one address-level advisory lock serializes setup, request, and activation;
- first-time setup and activation recheck active and pending ownership;
- an address conflict at activation cancels the request with an audit reason;
- terminal requests return idempotently without duplicate state or audit writes;
- the migration enforces merchant ownership, terminal timestamps, activation
  ordering, lowercase distinct addresses, pending uniqueness, and the partial
  due-work index;
- focused migration tests cover those constraints and the index predicate;
- response contracts include status and terminal timestamps;
- the worker processes due requests while leaving future requests pending.

The old four-item proof checklist now has implementation evidence in
`services/merchants/merchants.test.ts`:

| Original requirement                                  | Current evidence                                                             | Review disposition                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Concurrent worker emits no unexpected error           | Test at line 1135 spies on `logger.error` and checks event counts            | Present; independent database-session contention remains unproved.                      |
| Pending replacement versus first-time setup           | Test at line 1301 expects one 409 and exactly one address claimant           | Present; same concurrency limitation.                                                   |
| Audit rollback for request, cancellation, application | Tests at lines 1348, 1405, and 1464 inject audit ID collisions               | Present; complete snapshots and second application audit-write failure remain unproved. |
| Unexpected worker failure and retry                   | Test at line 1532 injects a throwing processor, then retries the due request | Present and passes; do not recreate this test as missing work.                          |

These line references describe the reviewed commit and may move after changes.

The remaining proof limitations are material to the protocol:

- `src/lib/testing.ts:29` uses a single PGlite instance. The installed Kysely
  PGlite driver uses one connection and exclusive transactions. `Promise.all`
  proves application-level overlapping calls, not competing PostgreSQL sessions
  contending for row/advisory locks. Add controlled multi-session integration
  evidence before claiming the no-deadlock and multi-worker requirements proved.
- Application writes two audit rows in `merchants.service.ts:398` and `:411`.
  The test at `merchants.test.ts:1501` fails the first insert. It does not prove
  rollback of an already-inserted audit row when the second insert fails.
  Snapshot and compare the exact wallet, request timestamps, and both event
  types across each failed transition.
- Early-activation tests use wall-clock fixtures but do not independently skew
  the application clock relative to the database. The implementation selects
  database time; add a regression that proves this security property.

No production deadlock or partial transaction commit has been reproduced by
this review. These findings limit acceptance evidence rather than establish
that those failures currently occur.

## Additional Backend Findings at `8cb28d6` (Resolved in A2)

The earlier read-only review identified issues outside the old four-test list.
They are retained here as the historical basis for Task A2; the current
disposition above records their accepted resolution.

1. **High, late settlement after timeout:** `checkout.service.ts:194-220`
   treats `dropped` as terminal after an absent receipt. Neither worker nor
   same-hash retries recover it when a valid receipt appears later. The previous
   frontend wording recommended a new link and stopped polling. Preserve the original
   hash and define recoverable late settlement plus safe customer guidance;
   missing RPC data must not by itself prompt a second payment.
2. **Medium, activation/creation boundary:**
   `payment-intents.service.ts:44-76` reads the merchant address and inserts the
   intent in separate autocommit operations. Activation can commit between them.
   Define a deterministic database order by reading/locking the merchant and
   inserting in one compatible transaction. Prove the overlapping case, while
   preserving existing links. Do not promise HTTP response ordering.
3. **Medium, security clock:** `merchants.middleware.ts:44` uses `Date.now()`
   for freshness. Wallet scheduling uses database `now()`, which is frozen at
   transaction start and can predate a lock wait. Define the delay's start point,
   test lock waits and application clock skew, and keep security decisions on
   the database clock.
4. **Medium, migration rollback:** the wallet migration's `down` restores an
   audit check that rejects existing new wallet-event types. Document and test
   a safe irreversible boundary or a history-preserving rollback procedure.
   The review did not run production rollback or migration rehearsals.

These are source-based findings, not claims of observed production incidents.
The nominal worker failure/retry coverage in the latest commit is adequate for
the worker loop contract.

The planning update at `8cb28d6` removed the frontend recommendation to pay a
new link and marked dropped-state recovery as a backend dependency. The runtime
and public-contract correction is accepted in `b2145e9`.

## Frontend Contract Review

The frontend routes, 200/202 behavior, pending read, fresh cancellation, and
active-address semantics match the backend. The document now also:

- requires `status: "pending"` on a 202 response;
- treats `activationAt` as eligibility rather than guaranteed completion;
- waits for `receivingWalletAddress` before labeling the new address active;
- requires `status: "cancelled"` and `cancelledAt` after cancellation;
- handles wallet-specific HTTP 409 conflicts;
- describes cancellation during the delay as the current recovery control.

## Verification

At `8cb28d6`, the 2026-09-06 review ran:

- typecheck, lint, and format check successfully inside `pnpm check`;
- `pnpm test` successfully outside the sandbox: 105 tests in eight files;
- `pnpm build` and `git diff --check` successfully.

There was no successful single end-to-end `pnpm check` invocation in this
environment. The sandbox blocked Supertest listening ports; the escalated full
command then encountered an environment-specific `.agents` directory scan error
in ESLint. Splitting the checks allowed each component to pass. Report this
execution limitation instead of claiming the aggregate command passed.

The suite covers the original four additions as well as early application,
cancellation versus activation, retry, migration constraints/indexes, lowercase
enforcement, uniqueness, and activation-time conflicts. Passing PGlite tests
does not replace the independent PostgreSQL concurrency evidence above.

## Completed Task A: Wallet Activation Proof

### 2026-09-07 Working-Tree Review

The first Task A implementation was reviewed as an uncommitted working-tree
change on `main` at `8cb28d6`. It adds a separate PostgreSQL suite, changes
wallet scheduling and fresh-session checks to use `clock_timestamp()`, samples
transition timestamps after the relevant locks, and strengthens the PGlite
rollback snapshots. No schema or public contract change is present.

The reviewer ran the full suite outside the restricted sandbox successfully:
107 tests in eight files. The dedicated PostgreSQL 16.15 suite also passed all
seven tests. Typecheck, lint, format checking, build, and `git diff --check`
passed. A sandboxed PostgreSQL run failed with the expected local-network
`EPERM`, then exposed the teardown issue below.

The 2026-09-07 follow-up review accepts the technical Task A evidence. The
independent-session activation-versus-cancellation cases now assert the exact
old or new active `user.receivingWalletAddress` for both lock orderings.
Partially initialized PostgreSQL resources are guarded during teardown; an
intentional unreachable-database run reports only the original connection
failure and no secondary cleanup `TypeError`.

The reviewer reran `pnpm check` successfully: 107 tests in eight files. The
dedicated PostgreSQL 16.15 suite again passed all seven tests, `pnpm build` and
`git diff --check` passed, and formatting remained clean. The clock-authority,
forced-lock-wait, separate backend-session, two-worker, reservation/setup,
rollback, second-audit-insert, and system-conflict requirements now have
accepted evidence.

Task A was committed as `88618ff` after this working-tree review. Its source
evidence and complete 50/72-compliant commit message are accepted, and the commit
is now at `origin/main`.

The old four additions are present in `8cb28d6`; `88618ff` closes the stronger
Task A evidence requirements. The original acceptance scope remains below as a
historical record.

Scope:

1. Prove worker, cancellation/activation, and reservation/setup races with
   independent PostgreSQL sessions, controlled overlap, both operation
   orderings, bounded completion, and exact state/audit/log assertions.
2. Prove complete rollback snapshots for all transitions, including failure of
   the second application audit write and system conflict cancellation.
3. Prove database-clock authority with independent application clock skew.
4. Preserve the existing observability and unexpected-worker-failure retry
   tests; these requirements already have passing focused coverage.
5. Keep the migration, corrected frontend contract, payment-link destination,
   timing, and existing concurrency tests green, then run `pnpm check`,
   `pnpm build`, `git diff --check`, and the PostgreSQL integration suite.

This correction did not add email delivery, webhooks, two-factor authentication,
wallet ownership signatures, or paging. With A2 accepted, the final planned
step 7 task is a durable outbox and alert dispatcher for wallet request,
cancellation, application, and paid-payment reorg events. Any further backend
findings discovered during review must also be resolved before branch sequencing
begins.

Before applying the earlier merchant-ownership repair migration to production,
run it against a recent copy or staging clone of the Railway database. Confirm
that legacy payment intents are preserved, placeholder merchant records are
acceptable, and the foreign-key constraint is restored successfully.
