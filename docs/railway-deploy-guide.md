# Deploying Senda on Railway

For a first-time Railway user. Checked on 2026-09-09 against deployed C3 commit
`7fa3136`, accepted C4 commit `fa1b3d6`, the current review notes, Railway CLI
5.50.2, and Railway staging and production plans. C3 is pushed and deployed
successfully to production as `adad5bc8`; C4 requires no deployment.

## 1. Start here: the staging backend is already online

Open the existing [Senda Railway project](https://railway.com/project/b29fcbf1-ab26-428c-b900-9f9a2e77670c).
Its current name is **earnest-strength**. Select **staging** in the environment
selector before opening a service.

| Environment | Service                | Observed deployment status       | Purpose                                                         |
| ----------- | ---------------------- | -------------------------------- | --------------------------------------------------------------- |
| staging     | `Postgres`             | `SUCCESS`                        | Stores merchant, payment, audit, and alert records.             |
| staging     | `senda-api`            | `SUCCESS`, deployment `d84658d8` | Runs the API and its background workers.                        |
| staging     | `senda-alert-receiver` | `SUCCESS`, deployment `2d1581cf` | Staging test mailbox; currently validates and logs test alerts. |
| production  | `Postgres`             | `SUCCESS`                        | Existing production database.                                   |
| production  | `senda-api`            | `SUCCESS`, deployment `adad5bc8` | Runs the production API and background workers.                 |

The staging API address is
`https://senda-api-staging.up.railway.app`. Its health endpoint is
[/api/health](https://senda-api-staging.up.railway.app/api/health).
There is no web frontend yet: a 404 at `/` is expected and does not mean the
API is offline.

The latest review already proved merchant registration, wallet setup, a delayed
replacement request, and delivery to the controlled receiver. See
[the review](../review-changes.md) for that evidence. A green deployment is not
proof that the customer payment flow or production rollout is ready.

### What still needs doing

1. **Development task C1:** complete. Commit `7186b7b` is accepted and staging
   deployment `4dde42cf` reached `SUCCESS` with healthy `/api/health` output.
2. **Operations task C2:** complete. Direct intake into **Senda Operations**
   passes, grouping uses `deliveryId`, the default route triggers **Senda
   Operator Notification**, and the final alert produced the expected email.
   This produces no code commit.
3. **Development task C3:** complete, accepted, and pushed as `7fa3136`. Its
   source, six-file scope, commit message, and both read-only Railway plans pass
   review. Its production creation plan has been applied.
4. **Operator/reviewer:** the production database credential and separate
   **Senda Production** Grafana integration are ready. The production API is
   online with all required variables, a healthy public endpoint, restart on
   failure capped at three attempts, and serverless sleeping disabled. Direct
   production delivery, human notification, and the initial external uptime
   check pass. Never paste a secret into chat.
5. **Development task C4:** complete and accepted as `fa1b3d6`. It preserves
   `BASE_RPC_URL` and `TRUST_PROXY_HOPS`, and independent redacted staging and
   production plans contain no variable deletion. Nothing was applied.

C1, C2, C3, production database rotation, Grafana setup, API deployment,
post-deployment settings, direct production alerts, notifications, and initial
uptime monitoring are retained above as the acceptance record. C4 is complete;
do not apply either reviewed plan or redeploy production for its source-only
guard. Any later IaC apply requires a new review of the then-current plan. There
is no need to recreate staging or rerun all backend tests just to inspect its
status.

## 2. Understand the three service boxes

A **project** groups Senda's infrastructure. An **environment** selects staging
or production, with separate settings and data. A **service** runs one component.
A **deployment** is one uploaded version of a service. A **variable** is a setting
or secret supplied to that service.

Senda's intended topology is:

```text
Merchant/browser -> senda-api -> Postgres
                         |
                 durable alert outbox
                         |
                         v
                    Grafana IRM -> email/operator
```

Checkout reconciliation, wallet activation, and alert dispatch already start
inside `senda-api` through `src/server.ts`. Do not create separate worker services
for this release. Keep one API replica and disable sleeping/serverless mode so
background work continues without browser traffic. The current request limiter
also assumes one API process.

The current receiver is a staging-only test mailbox. It proved that Senda can
authenticate and deliver an alert, but it does not notify a person. Keep it
unchanged until direct Grafana delivery passes. If that proof succeeds, do not
create a receiver service in production.

## 3. Check the API's Railway settings

In **staging → senda-api → Settings**, compare the actual settings with this
table. These values match the successful staging deployment.

| Setting                   | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| Source/build context      | Senda repository root, not `src` or `services`.         |
| Builder                   | Dockerfile.                                             |
| Dockerfile path           | `/Dockerfile`.                                          |
| Custom build command      | Empty; the Dockerfile installs dependencies and builds. |
| Pre-deploy command        | `node dist/src/lib/migrate.js up`                       |
| Start command             | `node dist/src/server.js`                               |
| Healthcheck path          | `/api/health`                                           |
| Healthcheck timeout       | 100 seconds.                                            |
| Restart policy            | On failure, maximum 3 retries.                          |
| Replicas                  | 1.                                                      |
| Sleeping/serverless       | Off.                                                    |
| Public domain target port | Match the app's `PORT`; staging currently targets 8080. |

The Dockerfile uses Node 22, builds TypeScript, and copies `dist` plus production
dependencies into the final image. The final image has no `tsx` or TypeScript
source tree. **Do not use `pnpm db:migrate` in Railway's pre-deploy command:**
that package script invokes `tsx src/lib/migrate.ts`. Use the compiled command
above. The compiled migrations are under `dist/migrations`.

Migrations run after the image builds and before the new API starts. Railway's
pre-deploy container can reach the environment's private network; a failed
pre-deploy command stops the deployment. Do not move migrations into the
Docker build. [Railway pre-deploy documentation](https://docs.railway.com/deployments/pre-deploy-command).

Railway supports a repo-root Dockerfile for the build. Keep its context intact,
including `package.json` and `pnpm-lock.yaml`.
[Railway Dockerfile documentation](https://docs.railway.com/builds/dockerfiles).

### Why the repository config is misleading

`railway.json` still names the old `pnpm` lifecycle commands. The successful
staging deployment uses corrected Railway-managed settings. Check the actual
deployment details, not just the file. Older services using legacy config can
have file settings override dashboard values.

Railway now deprecates `railway.json` and `railway.toml`, with a 2026-12-01 cutoff
for existing users. Its replacement is `.railway/railway.ts`. Renaming the JSON
file to TOML will not solve this. The development session should import the
working configuration, preserve secret references, review the plan, and commit
the supported configuration. Do not import plaintext secrets or apply a plan
that recreates the existing database.
[Config migration notice](https://docs.railway.com/config-as-code),
[Railway infrastructure-as-code](https://docs.railway.com/infrastructure-as-code).

## 4. Set variables on the correct service

Open **staging → senda-api → Variables**. Preserve existing valid values; do not
regenerate secrets each time you deploy. Add a missing variable using the
dashboard's variable editor, then apply the staged changes when ready.

| API variable                      | What to enter                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | `production`, including for the staging Docker deployment.                                        |
| `DATABASE_URL`                    | `${{Postgres.DATABASE_URL}}`, referencing Postgres in the same environment.                       |
| `BETTER_AUTH_URL`                 | `https://senda-api-staging.up.railway.app`; use the production API origin only in production.     |
| `BETTER_AUTH_SECRET`              | Existing generated secret, at least 32 characters; unique to this environment.                    |
| `BASE_RPC_URL`                    | The configured Base mainnet RPC endpoint; default is `https://mainnet.base.org`.                  |
| `TRUST_PROXY_HOPS`                | `1` for the currently documented direct Railway proxy setup; reassess if another proxy is added.  |
| `OPERATIONAL_ALERTS_MODE`         | `webhook`.                                                                                        |
| `OPERATIONAL_ALERT_WEBHOOK_URL`   | Current test-receiver URL; replace with the private Grafana IRM raw Webhook URL for direct proof. |
| `OPERATIONAL_ALERT_WEBHOOK_TOKEN` | Current receiver secret; replace with the Grafana service-account token for direct proof.         |

`staging` is the Railway environment name; `NODE_ENV=production` enables the
production application runtime in that environment. In webhook mode, this
runtime requires an HTTPS receiver URL and a token of at least 16 characters.
Do not copy `.env.example` wholesale: it contains local database/auth addresses
and disabled alert delivery.

Leave Railway's supplied `PORT` in place and ensure the public domain targets
that port. Do not assume Docker's `EXPOSE 3000` sets the Railway routing port.
The server reads `PORT` from its environment.

Keep the remaining rate, wallet-delay, and alert retry settings at their existing
defaults unless the development session deliberately changes them. In particular,
the alert lease must exceed the request timeout. Full names and defaults are in
[.env.example](../.env.example).

Use Railway's reference-variable picker for database links rather than copying
database passwords. Keep database traffic private; a localhost URL cannot reach
Railway Postgres from the API container.
[Railway variable documentation](https://docs.railway.com/variables).

For a new secret, generate it locally with a password manager or
`openssl rand -hex 32`, then transfer it directly to Railway's variable editor.
Keep it out of chat, source control, screenshots, and shared logs. Staging and
production must use different database, authentication, and Grafana secrets.

For the current production rollout, Railway created
`https://senda-api-production.up.railway.app` and all required values are
present. The two Grafana values were entered privately and were not exposed to
the reviewer or dev session.

## 5. Deploy the API version you intend

The current Railway status shows no connected GitHub repo source on the staging
API or receiver. These deployments were uploaded through the CLI. **Pushing to
GitHub alone does not currently guarantee a Railway deployment.**

### Existing CLI upload route

The Railway CLI is already installed and authenticated on this machine. After
the development session has committed and reviewed the logging fix, use the
repository root and explicitly select the API and staging environment:

```bash
cd /home/abiodun-longe/senda
git status --short
git log -1 --oneline
railway up --project b29fcbf1-ab26-428c-b900-9f9a2e77670c --environment staging --service senda-api --detach
```

`railway up` uploads the local directory, so inspect uncommitted changes first.
Save the deployment ID printed by the upload. Then check its status:

```bash
railway deployment list --project b29fcbf1-ab26-428c-b900-9f9a2e77670c --environment staging --service senda-api --limit 5 --json
```

Wait for that exact deployment to reach `SUCCESS`. Upload completion or `QUEUED`
does not mean the app is running. These CLI options were checked against the
installed CLI; see [Railway CLI documentation](https://docs.railway.com/cli).

### Optional GitHub route for later deployments

Keep production unlinked for now. The manual CLI route ensures that a dev-session
commit is reviewed here and explicitly approved before it reaches production.
If the release process later adopts automatic deployment, connect the Senda
repository, select the protected `main` branch, keep the root directory at `/`,
and preserve the Dockerfile/lifecycle settings above. Do not attach this repo to
the receiver service. Record the chosen route so the sessions do not mix an old
CLI snapshot with a newer GitHub commit.

## 6. Confirm it is working

First check **staging → senda-api → Deployments**:

1. The expected deployment is `SUCCESS`.
2. Its pre-deploy output shows migrations completed, or no outstanding migrations.
3. Its runtime logs show the server started on the intended port.
4. Open `/api/health` and expect HTTP 200 with:

```json
{ "success": true, "data": { "status": "ok" } }
```

This endpoint checks that Express responds. It does not query Postgres, Base
RPC, or the receiver. The prior review's migration and wallet smoke evidence
provides the deeper proof; a fresh release needs the targeted verification
selected by the reviewer.

After the logging fix is accepted and deployed, the reviewer/operator can
repeat the staging merchant-wallet flow and verify a real alert reaches Grafana
and the selected human recipient. Use staging test accounts and keep cookies out
of shared output. This does not require sending customer funds.

Railway's deployment healthcheck is not continuous uptime monitoring. Add an
external availability check for the API before relying on unattended production
operations. An in-process alert worker cannot report that its own process is
down. [Railway healthcheck documentation](https://docs.railway.com/deployments/healthchecks).

## 7. Connect operational alerts directly to Grafana

Grafana has two separate jobs here:

- a Synthetic Monitoring check watches `/api/health` and tells you when the API
  is down or slow;
- Grafana IRM receives Senda's four important business alerts and notifies you.

This setup does not deploy Senda. Railway runs the application; Grafana watches
it and receives its alerts.

### A. Watch whether the API is online

1. From Grafana's recommendation screen, choose **Monitor a URL**.
2. Use `https://senda-api-staging.up.railway.app/api/health`.
3. Name the check **Senda Staging API** and choose a small set of nearby probes.
4. Keep the expected result as HTTP 200. Add an email contact point so the check
   can notify you when repeated checks fail.

Do not monitor `/`; that route correctly returns 404 because there is no web
frontend yet. Create a separate production check only after the production API
has its own address.

### B. Receive Senda's own alerts

1. Open **Alerts & IRM → IRM → Integrations → Monitoring systems**.
2. Add **Webhook**, choose the raw Webhook option rather than Formatted Webhook,
   and name it **Senda Operations**. Senda already sends structured JSON, so it
   does not need another Railway service to reshape the message.
3. Require a Grafana service-account bearer token. Copy the generated webhook
   URL and token privately. Do not paste them into chat, Git, screenshots, or
   shared logs.
4. In **staging → senda-api → Variables** on Railway, replace only these values:
   `OPERATIONAL_ALERT_WEBHOOK_URL` gets the Grafana webhook URL, and
   `OPERATIONAL_ALERT_WEBHOOK_TOKEN` gets the Grafana token. Keep
   `OPERATIONAL_ALERTS_MODE=webhook`.
5. In Grafana, make a route and notification rule that sends these Senda alerts
   to your email. Use `deliveryId` as the stable identity when configuring
   grouping so a retry does not create a new alert group.
6. After the HTTP-log fix is deployed, trigger one safe merchant wallet-change
   request. Confirm Grafana shows it, the email arrives, and the database alert
   row becomes `delivered`. Do not send customer funds for this test.

Direct intake was proven with Grafana alert group #3 and delivery
`5b28ee4d-37fd-4d96-b4be-65eb2ec07b45`. The first group was visible and
acknowledged, but Grafana skipped escalation because the default route had no
chain. Grouping now uses `{{ payload.deliveryId }}`, and the default route now
triggers **Senda Operator Notification**. Final delivery
`80be213c-c38a-41ea-aefc-5f9e39133cbb` was accepted in one attempt, and its
email reached the operator. C2 is complete.

The four Senda event types Grafana must receive are:

- wallet change requested;
- wallet change cancelled;
- wallet change applied;
- a paid payment was changed by a blockchain reorganization.

The payload may contain only the event kind, environment, event time, delivery
ID, and the existing allowlisted record IDs. It must not contain wallet
addresses, passwords, cookies, tokens, or database URLs.

Keep `senda-alert-receiver` unchanged until this direct test passes. If it does
pass, the receiver is not needed in production. If Grafana rejects the direct
payload, save only the safe error status and reason; then scope a small
translation service as a separate task.

Production uses a separate raw Webhook integration named **Senda Production**
with its own token and the existing operator notification route. A live wallet
change request and its cleanup cancellation each reached that integration in
one attempt with HTTP 200. Confirm the resulting human email separately.
[Grafana IRM incoming webhook documentation](https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/integrations/custom-integrations/incoming-webhooks/oncall-webhooks/).

## 8. Troubleshoot by the failing stage

| Symptom                                          | Check first                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Docker build cannot find the lockfile/source     | Build context must be the repository root.                                                                        |
| `tsx: not found` or missing `src/lib/migrate.ts` | Replace the old pre-deploy command with `node dist/src/lib/migrate.js up`.                                        |
| Migration cannot connect to Postgres             | Same Railway environment, private `DATABASE_URL` reference, database running.                                     |
| Migration refuses to proceed                     | Give the sanitized migration name/error to the dev session; do not delete rows or run `down` to force deployment. |
| API exits with environment validation errors     | Required URL/secret values, webhook mode URL/token, HTTPS, lease longer than timeout.                             |
| 502 or failed healthcheck                        | Start command, `PORT`, domain target port, and `/api/health`.                                                     |
| `/` gives 404                                    | Expected for the current API-only release.                                                                        |
| Login/session does not work                      | Correct HTTPS `BETTER_AUTH_URL`, correct environment, cookies and same-origin requests.                           |
| Grafana returns 401/403                          | Check that the API uses the service-account token required by the Grafana Webhook integration.                    |
| Outbox is `delivered`, but no email arrives      | Check the Grafana route, contact point, and notification policy separately from webhook acceptance.               |
| A GitHub push does nothing                       | Current CLI-upload services need a new upload or an explicitly configured GitHub source.                          |
| Background work stops when traffic stops         | Sleeping/serverless must be off; confirm the API process is running.                                              |

Use Railway's **Build**, **Pre-deploy**, and **Deploy** logs for the relevant
stage. Share the deployment ID and a sanitized error, not raw logs, environment
dumps, database URLs, authorization headers, or cookie headers. Existing logs
may contain credentials until the recorded fix is deployed.

## 9. Production rollout status

The initial production rollout completed on 2026-09-09:

1. Confirm the HTTP-log correction is accepted and staged successfully, the
   direct Grafana staging proof passed, the production database credential
   rotation passed, and required existing-data migration rehearsals are
   recorded. These gates passed on 2026-09-09.
2. Preserve the existing production Postgres service and its volume. Provision
   the API in this environment. Do not provision an alert receiver if the direct
   Grafana staging proof passed.
3. Configure production-only secrets, database reference, API origin, and alert
   destination. Do not copy staging credentials or test-recipient URLs.
4. Accepted commit `7fa3136` was deployed using the compiled migration and start
   commands. Deployment `adad5bc8` reached `SUCCESS` and `/api/health` passed.
5. Effective lifecycle settings match C3. Two live production events reached
   Grafana in one attempt each, the operator received the notifications, and
   the one-minute production synthetic check initially reports 100% uptime and
   reachability.
6. For rollback, follow [the migration guide](../migrations/README.md). Do not
   run database `down` migrations as a routine response to an application crash;
   accepted migrations deliberately protect audit history.

The agreed repository sequence remains: **finish backend → `flow` → review and
merge into `main` → update `app` from `main` → frontend implementation**.
Deploying the current API does not complete the customer/Turnkey work or change
that order.
