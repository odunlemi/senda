# Senda Frontend MVP Plan

## How to Use This Document

Pass this file to the frontend implementation session together with
`docs/backend-plan.md`, `docs/customer-payment-flow-plan.md`, and
`docs/commit-spec.md`.

The implementation session should:

1. treat **User Suggestions** below as overrides to the defaults in this plan;
2. inspect the current repository before adding dependencies or changing build
   configuration;
3. use the dedicated `app` branch for all frontend changes and commits, and
   verify the active branch before starting implementation;
4. keep frontend commits separate from backend prerequisite work; implement the
   backend tasks below outside the `app` branch and merge their contracts in;
5. implement the frontend in small, independently verified commits;
6. keep the first version limited to backend capabilities that exist now.

## User Suggestions

These choices override conflicting defaults elsewhere in this plan.

- **Visual foundation:** Use shadcn/ui's Luma style with Base UI primitives,
  Tailwind CSS design tokens, Lucide icons, and restrained elevation. Treat the
  supplied dark financial-dashboard screenshots as a token and component
  reference, not as a page-layout requirement.
- **Preset application:** This is an existing repository containing a new web
  application. First scaffold the Vite React TypeScript application at
  `apps/web`, then use shadcn's **Existing Project** workflow from that
  application to apply the full `b1GwSVbE2` preset. Do not use the New Project
  workflow to create another repository or copy the preview dashboard layout.
  After applying the preset, add only the components the product uses.
- **Brand colors and typography:** Use Inter and the supplied earthy palette:
  terracotta `#BA2D0B`, mint `#D5F2E3`, frosted turquoise `#73BA9B`, dark pine
  `#003E1F`, and forest black `#01110A`. In light mode, use forest black for
  text, dark pine for primary actions, mint for soft surfaces, frosted turquoise
  for selected and accepted states, and terracotta only for destructive or
  high-attention states. In dark mode, use forest black for the page, derived
  dark-pine surfaces, mint text, and frosted turquoise for primary and accepted
  states. Derive any additional neutral surfaces from these colors and verify
  WCAG AA contrast. Pair every status color with text and an icon.
- **Logo or wordmark:** Use a simple text wordmark until a dedicated identity is
  supplied.
- **Preferred frontend framework:** Keep Vite, React, strict TypeScript, and
  React Router. Use shadcn components owned by the application rather than a
  separately themed component package.
- **Customer wallet requirement:** Use a Turnkey-backed embedded EOA provisioned
  as part of the customer account and restored after login. Do not show a
  connect-wallet step. Tapping Pay must invoke an OS passkey or biometric
  confirmation for that exact transaction. Keep Turnkey behind a Senda-owned
  adapter and never expose signing material. For the MVP, the customer wallet
  must hold both USDC and enough Base ETH to pay transaction gas.
- **Prohibited wallet dependencies:** Do not add the Coinbase Wallet SDK or
  connector, OnchainKit, Base Account, or Coinbase APIs. Base UI is the shadcn
  component primitive choice and is unrelated to Coinbase services.
- **Landing page:** Build a compact product-facing page with the primary message
  "Accept USDC on Base with a payment link," a short three-step explanation, a
  trust and safety note, and merchant registration and sign-in actions. Do not
  invent testimonials, payment volume, or unsupported product claims.
- **Merchant workspace priorities:** Keep the MVP focused on wallet setup and
  payment-link creation. Do not introduce a dashboard sidebar, charts, balances,
  or browser-persisted payment history.
- **Checkout-page priorities:** Use one quiet, centered payment card. Present the
  unshortened amount first, followed by recipient and payment details, expiry,
  one primary wallet action, and transaction progress. Use inline errors and
  reserve transient notifications for actions such as successful copying.
- **Mobile behavior:** Treat mobile checkout as a primary flow. The embedded
  wallet must work in an ordinary mobile browser through account login and an
  OS-backed passkey or biometric prompt, without an extension, deep link, QR
  handoff, or `window.ethereum`. Test account recovery and payment authorization
  on an ordinary Android browser before calling the flow complete.
- **Color mode:** Default to light mode and provide an accessible light/dark
  switch. Persist an explicit user choice locally, but use light when there is no
  saved preference rather than following the operating system. Apply the saved
  theme before first paint to avoid a flash, and define both modes through
  shadcn and Tailwind design tokens.
- **Payment-link expiration:** Default new links to 24 hours while allowing the
  merchant to choose another valid future expiry.
- **Base network guidance:** Configure the embedded wallet for Base as part of
  provisioning. Do not show a switch-network or Add Base step in the normal
  customer flow. If the provider cannot access Base, stop before authorization
  and show a service-availability message rather than asking the customer to
  repair wallet network settings.
- **Settlement review language:** Use a strong actionable warning:
  "Payment received. Settlement is under review. Do not fulfill this payment yet."
- **Forms and feedback:** Start with React form state and the shared Zod schemas;
  add no form library unless implementation complexity justifies it. Use inline
  validation and accessible live regions, with a lightweight shadcn-compatible
  notification such as Sonner only for transient feedback.
- **Accessibility requirements beyond the baseline:** Preserve the complete
  baseline below, including keyboard operation, visible focus, reduced motion,
  and unshortened payment amounts.

## Product Goal

Build the smallest complete web experience for Senda's existing Base/USDC
payment-link backend:

- a merchant can register or sign in;
- a merchant can configure one receiving wallet;
- a merchant can create a one-time payment link and copy it;
- a logged-in customer can open the public link, review the exact payment, tap
  Pay, and authorize it through the embedded wallet without a connect step;
- both parties can observe confirmation status and read the final receipt.

Do not build features the backend cannot support yet.

## Wallet Architecture Decision

### Separate Account Login From Payment Authorization

Senda account login identifies the customer and restores their embedded wallet.
It must not silently authorize spending. Tapping Pay is the customer's explicit
intent to make one payment, but the wallet still needs a cryptographic
authorization mechanism before funds move.

The preferred user experience is:

1. the customer creates or signs into a Senda account;
2. Senda restores the wallet already attached to that account;
3. the customer opens a payment link and reviews the exact amount and merchant;
4. the customer taps Pay;
5. an OS passkey or biometric prompt authorizes that exact payment;
6. Senda submits or tracks the payment and shows confirmation status.

There is no connect-wallet screen in this primary flow.

### Merchant Wallet Choices

1. **External receiving address, current model and recommendation.** The merchant
   supplies a Base address and USDC settles directly to it. Senda does not hold
   merchant funds or keys. The existing backend already supports this model.
2. **Verified external receiving address.** Add a one-time ownership signature
   during merchant wallet setup. This reduces address-entry and account-takeover
   risk but requires a merchant-only signing flow and backend verification.
3. **Embedded merchant wallet.** Provision and recover a wallet for the merchant.
   This simplifies setup but creates a much larger custody, recovery, provider,
   and business-continuity responsibility.
4. **Platform-custodied merchant wallet.** Senda controls settlement keys. Do not
   use this for the MVP because it materially changes the product and risk model.

Keep option 1 for the MVP. Treat option 2 as a later hardening feature. Customer
wallet architecture does not require the merchant to use the same wallet model.

### Customer Wallet and Gas Choices

| Choice                             | Customer experience                               | Gas model                    | Current backend                                              |
| ---------------------------------- | ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Embedded EOA                       | Login, tap Pay, approve with passkey or biometric | Customer holds Base ETH      | Compatible with direct USDC transfer verification            |
| Embedded EOA plus EIP-3009 relayer | Login, tap Pay, sign one USDC authorization       | Senda relayer pays gas       | Requires a new authorization and relay backend path          |
| Passkey smart account              | Login, tap Pay, approve a user operation          | Paymaster can sponsor gas    | Requires account-abstraction verification and reconciliation |
| Backend-custodied wallet           | Login and app-controlled payment                  | Platform pays or manages gas | Requires custody controls and is not recommended             |

The selected MVP is the direct embedded EOA option. It works with the current
checkout verifier and meets the no-connect requirement, but every customer must
hold a small Base ETH balance as well as USDC. The funding UI must show both
balances and explain the gas requirement before Pay.

Defer EIP-3009 relaying and passkey smart accounts. EIP-3009 is the narrower
future gasless upgrade for Base/USDC, but it requires nonce, expiry, replay
protection, relayer funding, idempotency, and a new backend verifier. A smart
account adds account deployment, bundler and paymaster dependencies,
user-operation hashes, inner-call validation, and different reconciliation. The
current backend expects a normal transaction sent directly to the USDC contract
and will reject an ERC-4337 bundle sent through an EntryPoint.

### Selected Embedded Wallet Provider

Use Turnkey directly behind a Senda-owned adapter and UI. Create one isolated
customer wallet identity per Senda customer, authorize each transaction through
the customer's passkey, and keep Senda unable to sign unilaterally. Do not build
key management in Senda or substitute a platform API key for user approval.

Before implementation, run a focused Turnkey proof of concept that confirms
Base mainnet direct EOA transactions, Android passkey creation and recovery in
Nigeria, wallet export or a credible exit path, device migration, transaction
policy behavior, pricing, and provider-outage handling. Do not proceed from a
demo alone, and do not use a Coinbase-dependent provider path.

### Per-Payment Authorization Choices

1. **Passkey or biometric confirmation for every payment, recommended.** The Pay
   action opens an OS-backed confirmation and authorizes only the displayed
   payment. This preserves explicit approval without a wallet connection flow.
2. **Pre-authorized session key with amount and time limits.** Pay can complete
   with less friction after one earlier approval, but revocation, device theft,
   limits, and policy enforcement are substantially more complex.
3. **Password or PIN confirmation.** Familiar but weaker against phishing and
   does not itself provide a blockchain signer unless an embedded provider uses
   it to release signing authority.
4. **Backend signing without a user prompt.** This is custodial or delegated
   spending and conflicts with Senda's explicit-approval model. Do not use it.

The selected MVP is option 1. Tapping Pay starts the payment and then the OS
passkey or biometric prompt authorizes it. There is no wallet connection step.
Do not add a session key or remove per-payment confirmation without a separate
security and product specification.

### Backend Dependency for the No-Connect Flow

The customer identity, Turnkey wallet, balance, recovery, and customer-bound
checkout backend work is specified separately in
`docs/customer-payment-flow-plan.md`. That work belongs on the dedicated `flow`
branch.

The `app` branch may implement scaffolding, the theme system, merchant UI,
public payment details, and receipts against existing contracts. Do not ship the
customer Pay flow until the required `flow` contracts are complete and merged.
Do not substitute an external connect-wallet flow for the selected embedded
wallet architecture.

The backend Task A2 review has accepted the late-settlement contract. Public
payment intents expose `submittedAt`, `monitoringExpiresAt`, and
`monitoringEscalatedAt`. A missing receipt moves the intent to unresolved
`dropped` after five minutes, while the server continues checking the original
hash for up to 24 hours. A later valid receipt can return it to `confirming` or
settle it as `paid`; even after automated monitoring escalates, manual backend
reconciliation remains available. Never infer failure or prompt a second payment
from missing receipt data alone.

## Default Technical Direction

Unless the user suggestions choose otherwise:

- create `apps/web` with Vite, React, and strict TypeScript;
- use React Router as the lightweight client-side router;
- use the existing Zod contracts instead of duplicating API response types;
- use React state and small context providers rather than adding a global state
  library;
- use native `fetch` through one typed API client;
- use viem for Base transaction primitives and isolate the Turnkey SDK behind a
  Senda adapter so product code and tests do not depend directly on
  provider-specific APIs;
- use shadcn/ui with Base UI primitives, Tailwind CSS design tokens, and only the
  components needed by the application;
- keep the application same-origin in development and production.

Check package release dates and repository conventions before adding any new
dependency.

## Backend Capabilities Available Now

All responses use JSON. Successful responses have `success: true`; handled
errors use `{ "success": false, "error": string }`.

| Method | Path                                        | Access   | Frontend use                            |
| ------ | ------------------------------------------- | -------- | --------------------------------------- |
| POST   | `/api/merchants`                            | Public   | Register merchant and set cookie.       |
| POST   | `/api/merchant-sessions`                    | Public   | Sign in merchant and set cookie.        |
| GET    | `/api/merchant-sessions/current`            | Merchant | Restore the current merchant.           |
| PUT    | `/api/merchant-wallet`                      | Fresh    | Set or request a receiving address.     |
| GET    | `/api/merchant-wallet/pending`              | Merchant | Read the current pending replacement.   |
| DELETE | `/api/merchant-wallet/pending`              | Fresh    | Cancel the current pending replacement. |
| POST   | `/api/payment-links`                        | Merchant | Create a Base/USDC payment intent.      |
| GET    | `/api/payment-links/:publicId`              | Public   | Read payment details and status.        |
| POST   | `/api/payment-links/:publicId/checkout`     | Public   | Prepare the exact transaction.          |
| POST   | `/api/payment-links/:publicId/transactions` | Public   | Submit the approved transaction hash.   |
| POST   | `/api/payment-links/:publicId/confirm`      | Public   | Trigger manual reconciliation.          |
| GET    | `/api/payment-links/:publicId/receipt`      | Public   | Read a paid payment receipt.            |

Merchant endpoints use an HTTP-only session cookie. Frontend requests should
use same-origin URLs and `credentials: "include"`; do not store auth tokens or
session cookies in JavaScript storage.

The public payment ID is already a capability identifier. Do not expose internal
merchant data beyond what the existing contracts return.

## Backend Gaps the Frontend Must Respect

The backend does not currently provide:

- a sign-out endpoint;
- password reset, account recovery, or two-factor authentication;
- a merchant payment-link list or payment history;
- a merchant receipt list;
- payment-link editing, cancellation, or deletion;
- email delivery or PDF receipts;
- a hosted or embedded customer wallet;
- multi-chain, multi-token, FX, swap, or subscription support;
- a public merchant profile or stable merchant display name in payment data.

Do not simulate these features with local-only state. For example, clearing
React state is not a real sign-out while the server session cookie remains
valid. Show only functionality backed by an API.

## Application Routes

Use these default web routes unless user suggestions replace them:

| Route                    | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `/`                      | Compact product page and merchant entry points. |
| `/merchant/sign-up`      | Merchant registration.                          |
| `/merchant/sign-in`      | Merchant sign-in.                               |
| `/merchant`              | Wallet setup and payment-link creation.         |
| `/pay/:publicId`         | Public payment details and checkout.            |
| `/pay/:publicId/receipt` | Public read-only receipt.                       |
| `*`                      | Branded not-found page.                         |

The merchant route should restore the session from the backend before rendering
protected content. A 401 should redirect to sign-in without treating a stale
client object as authenticated.

## Shared API Client

Create one API module that:

- uses relative `/api/...` URLs;
- sends `credentials: "include"`;
- sets JSON request headers only when a body is present;
- parses successful responses with the existing Zod schemas;
- converts non-success responses into one typed application error;
- preserves HTTP status and `Retry-After` for UI decisions;
- distinguishes network failure from an API rejection;
- never logs passwords, cookies, full wallet requests, or other secrets.

Reuse the contracts under `contracts/` through an alias or workspace-safe
relative import. Add inferred frontend types where a contract does not currently
export one; do not create a separate set of hand-written response interfaces.

Handle these statuses consistently:

- `400`: display the backend validation message near the relevant action;
- `401`: restore or redirect merchant authentication;
- `403`: prompt for reauthentication when the session is too old for a sensitive
  action, then retry the original request without including the password;
- `404`: show a missing payment-link or receipt state;
- `409`: show the context-specific conflict, including an unpaid receipt, an
  existing pending wallet replacement, or an address reserved by another
  merchant;
- `429`: honor `Retry-After`, disable immediate retries, and show a countdown;
- `500`: show a generic retry message without exposing server details.

## Merchant Experience

### Registration and Sign-In

Registration fields:

- business or merchant name;
- email;
- password of 8 to 128 characters.

Sign-in fields:

- email;
- password.

On a successful 201 response, use the returned merchant object and navigate to
`/merchant`. On application reload, call the current-session endpoint before
deciding whether the merchant is signed in.

`emailVerified` may be displayed as account information, but do not block the
MVP flow because there is no verification workflow yet.

### Receiving Wallet Setup

If `receivingWalletAddress` is null, make wallet setup the primary onboarding
action. Otherwise show the configured active address and allow the merchant to
request a replacement. First-time setup is immediate; a replacement becomes a
pending change that activates after the configured delay.

Requirements:

- validate `0x` plus 40 hexadecimal characters before submission;
- submit first-time setup or a replacement request through `PUT /api/merchant-wallet`;
- a 200 response means the address is active; a 202 response must have
  `status: "pending"`, and `activationAt` is the earliest time it is eligible for
  activation;
- use the canonical address returned by the API (active `receivingWalletAddress`
  or pending `requestedAddress`);
- never label this as a custodial Senda wallet;
- require a clear confirmation step before replacing an existing address;
- show the pending state and scheduled activation time after a 202 response, but
  do not label the requested address active until the current-merchant response
  returns it as `receivingWalletAddress`;
- use `GET /api/merchant-wallet/pending` to restore the pending state on reload
  and poll after `activationAt` because worker execution can occur later;
- use `DELETE /api/merchant-wallet/pending` to cancel a pending replacement;
  require `status: "cancelled"` and `cancelledAt` in the successful response,
  then clear the local pending state;
- keep new payment links using the active address until activation completes;
- if the backend responds with `403` because the session is not fresh, prompt
  for the password and call `POST /api/merchant-sessions`, then retry the
  password-free wallet request; do not send the password inside the wallet
  request or use local timestamps as proof of freshness;
- describe cancellation before activation as the available recovery control;
  do not imply that out-of-band notification or two-factor protection exists.

### Payment-Link Creation

The backend accepts an atomic USDC amount, but the merchant UI should accept a
human decimal amount and convert it without floating-point arithmetic.

For Base USDC:

- use six decimal places;
- reject zero, negative, exponent, and more-than-six-decimal inputs;
- convert the validated string to `amountAtomic` using string or bigint logic;
- format atomic amounts back to human-readable USDC consistently.

Collect:

- required amount;
- required future expiration time, defaulting to 24 hours;
- optional description, maximum 500 characters;
- optional reference, maximum 200 characters.

After creation, display:

- amount, asset, destination, and expiry;
- the public URL `${location.origin}/pay/${publicId}`;
- a copy-link action with success feedback;
- an action to create another link.

Do not build a payment history from browser storage. The backend has no merchant
list endpoint, so a refreshed merchant workspace cannot reconstruct earlier
links.

## Public Payment Experience

### Initial Read

Load `GET /api/payment-links/:publicId` before preparing checkout. Display the
stored amount, USDC asset, Base chain, destination, description, reference, and
expiry. Visually truncate long addresses and hashes, but keep the full value
available to copy and to assistive technology.

Do not call the mutating checkout endpoint merely because the page rendered.
Call it only after the customer chooses to continue toward payment.

### Payment States

Render explicit states rather than one generic spinner:

| Status             | Customer behavior                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `created`          | Show payment details and an enabled Pay action.                                                          |
| `awaiting_payment` | Allow payment approval or resume the checkout prompt.                                                    |
| `confirming`       | Disable duplicate payment actions and poll while monitoring has not escalated.                           |
| `paid`             | Show success and link to the receipt.                                                                    |
| `expired`          | Explain that the link can no longer be paid.                                                             |
| `failed`           | Explain that the submitted transaction failed verification.                                              |
| `dropped`          | Explain that settlement is unresolved, keep the original hash visible, and never prompt another payment. |

Use the absolute `expiresAt` timestamp for a countdown, but treat the backend
status as authoritative if the browser clock disagrees.

### Embedded Wallet Approval

Keep signing behind the customer's explicit Pay action, but do not show a wallet
connection or network-selection step.

1. Require an authenticated customer session and a provisioned embedded wallet
   before enabling Pay.
2. Restore the wallet through the Senda adapter without exposing provider keys,
   recovery material, or connector UI.
3. Load the current payment intent and present the exact amount, merchant
   destination, expiry, and fee model before authorization.
4. On Pay, request a passkey or biometric confirmation bound to that payment.
5. Call the existing checkout endpoint and use its returned `to`, `data`, and
   `value` exactly. The Turnkey-backed EOA signs and broadcasts the Base
   transaction, and the returned hash goes to the existing transaction endpoint.
6. Never request a signature or transaction when the payment is expired or
   already confirming, paid, failed, or dropped.

Handle common embedded-wallet outcomes:

- customer session missing or expired: preserve the payment return URL and ask
  the customer to sign in;
- wallet not provisioned or recovery required: stop before Pay and enter the
  provider's account recovery flow;
- passkey or biometric rejected: return to the ready state without submitting a
  transaction or authorization;
- insufficient USDC: show the required and available balance without initiating
  a payment;
- insufficient Base ETH in direct EOA mode: explain the gas requirement and do
  not imply that Senda sponsors it;
- Turnkey or Base unavailable: preserve the payment details and show a retryable
  service error without requesting an external wallet connection;
- embedded wallet address changed unexpectedly: stop and require session and
  wallet restoration before another payment attempt.

Do not request token approvals. The selected direct EOA mode uses the backend's
exact USDC `transfer` and requires Base ETH for gas.

### Transaction Submission and Confirmation

The existing transaction-hash flow below applies to direct EOA payments. An
EIP-3009 or smart-account choice needs its own backend submission and status
contract before the frontend implements it.

The wallet may return a hash before the backend RPC can read the transaction.
If submission returns `Transaction not found on Base`, retry the same hash with
bounded backoff while respecting the RPC rate limit. Do not ask the customer to
send another transaction.

After the hash is accepted:

- show `confirming` immediately;
- display the transaction hash with copy support;
- poll the public GET endpoint rather than repeatedly calling manual confirm;
- use a modest interval such as five seconds and pause when the tab is hidden;
- continue polling `confirming` and `dropped` while
  `monitoringEscalatedAt === null`; use `monitoringExpiresAt` to explain how long
  automated monitoring may continue, but let backend fields remain authoritative;
- stop active polling on `paid` or `failed`. If monitoring escalates while the
  intent is still `confirming` or `dropped`, stop high-frequency polling, explain
  that the original payment is under review, preserve a manual status refresh,
  and do not expose another payment action;
- honor 429 `Retry-After` and apply backoff after network errors.

The server reconciliation worker is authoritative and continues after the page
closes. The frontend must be able to resume from the public GET response after a
reload.

## Receipt Experience

For a paid payment, load `/api/payment-links/:publicId/receipt` and display:

- public payment ID;
- formatted USDC amount and atomic amount where useful;
- chain;
- payer and destination addresses;
- transaction hash;
- confirmation count;
- Senda acceptance timestamp (`paidAt`);
- description and reference when present.

Treat `paidAt` as Senda's acceptance time, not the on-chain block time.

Settlement display:

- `accepted`: show the normal paid receipt;
- `review_required`: retain the receipt facts but show the prominent warning
  "Payment received. Settlement is under review. Do not fulfill this payment yet."
  Do not present an unqualified final-success message.

The receipt is an HTML application view. PDF generation, downloading, email,
receipt numbering, and invoice fields remain out of scope.

## Visual and Accessibility Baseline

Apply the confirmed visual direction above while preserving this baseline:

- use a clean, restrained payment-product layout;
- prioritize payment facts and approval state over marketing decoration;
- support mobile widths first and a centered desktop content column;
- use design tokens for color, spacing, radius, typography, and elevation;
- meet WCAG AA contrast for text and interactive controls;
- provide visible focus states and full keyboard operation;
- associate every field with a label and accessible error text;
- use `aria-live` for transaction, confirmation, copy, and retry feedback;
- do not communicate payment status through color alone;
- respect reduced-motion preferences;
- avoid celebratory animation until settlement is truly `accepted`.

Never shorten an amount. Addresses and hashes may be visually truncated only if
the full value remains available through copy and an accessible label.

## UI Content Standards

Apply these rules to all customer-facing and merchant-facing text:

- use sentence case for headings, buttons, labels, statuses, and notifications;
- write concise, specific, active-voice instructions with familiar words;
- do not use em dashes in UI text; split the thought into sentences or use a
  colon when it introduces supporting information;
- use precise action labels such as "Create payment link," "Pay," "Copy link,"
  and "View receipt" instead of generic labels such as "Submit," "OK," or
  "Continue" when the action can be named;
- omit terminal punctuation from buttons, navigation items, labels, and short
  headings, but punctuate complete descriptions, alerts, and error messages;
- explain what happened and the next available action in error, empty, and
  unavailable states without blaming the user or exposing raw server, wallet,
  or RPC details;
- use the product terms merchant, customer, payment link, receiving wallet,
  Base, USDC, transaction hash, and receipt consistently; do not alternate with
  invoice, order, or account balance when those concepts are not supported;
- avoid all caps, unnecessary title case, exclamation marks, fake urgency, and
  promotional claims that the product cannot substantiate;
- describe expiry and payment status factually, and do not imply final settlement
  until the backend reports an accepted receipt;
- give icon-only controls accessible names that describe their action or result,
  and keep live-region updates short enough to understand when announced.

## Build and Same-Origin Deployment

The frontend must remain part of this repository and ship from the Express
origin.

Implementation requirements:

1. Add `apps/web/package.json`, its own strict browser TypeScript config, and
   Vite configuration.
2. Add a Vite development proxy for `/api` to the local Express server so auth
   cookies remain same-origin from the browser's perspective.
3. Configure only the selected embedded-wallet provider's browser-safe project
   identifiers through `VITE_*` environment variables and restrict them to
   Senda's allowed origins. Never place signing credentials, private keys, or
   backend provider secrets in the frontend bundle.
4. Build frontend assets into a path included in the production artifact, such
   as root `dist/web`.
5. Update root scripts so `pnpm build`, typecheck, lint, format check, and tests
   include the web workspace without weakening backend checks.
6. Update the Docker dependency stage to copy `pnpm-workspace.yaml` and the web
   package manifest before `pnpm install --frozen-lockfile`.
7. Ensure the runtime image contains the built web assets.
8. Serve static assets from Express in production and return the SPA entry point
   for non-API application routes.
9. Preserve JSON 404 behavior under `/api`; never let the SPA fallback turn an
   unknown API route into HTML.
10. Keep `/api/health` unchanged for Railway and Docker health checks.

Do not introduce CORS or a separate frontend deployment.

## Testing Strategy

Add focused tests rather than relying only on manual wallet testing.

### Unit Tests

Cover:

- decimal USDC to atomic conversion and formatting;
- expiry and wallet-address validation;
- API success and error parsing;
- 429 retry timing;
- payment-state presentation;
- embedded-wallet provisioning and restoration state normalization;
- passkey or biometric rejection and provider outage handling;
- USDC and Base ETH balance and gas requirement states;
- Turnkey passkey authorization request normalization;
- wallet error normalization.

### Component Tests

Use a browser-like test environment with injected API and embedded-wallet
adapters. Cover:

- merchant and customer registration and sign-in forms when their backend
  contracts exist;
- current-session restoration and 401 redirect;
- initial merchant wallet setup, pending replacement, scheduled activation,
  cancellation, and fresh-session retry;
- payment-link creation and copied public URL;
- public payment rendering for every status;
- embedded customer wallet provisioning, restoration, and recovery-required
  states;
- Pay without a connect-wallet or network-selection screen;
- explicit passkey or biometric approval and rejection;
- transaction submission retry with the same hash in direct EOA mode;
- confirming-to-paid polling;
- accepted and review-required receipts;
- keyboard operation and important accessible names.

Do not call Base RPC, a real wallet, a live embedded-wallet provider, a relayer,
or the production API from automated tests. Fake wallet and authorization
adapters should record requested operations and return controlled results.

### Integration Checks

Verify that:

- Vite proxies `/api` in development;
- Express serves web assets and client routes in production mode;
- unknown `/api` routes still return JSON 404;
- frontend and backend builds succeed from the repository root.

## Delivery Sequence

Implement in this order:

1. **Scaffold and integration**
   - create `apps/web`;
   - configure strict TypeScript, Vite, linting, testing, and shared contracts;
   - wire root builds, Docker output, Express static serving, and API fallback
     separation.
2. **API and session foundation**
   - build the typed API client;
   - add application routing and session restoration;
   - implement common loading, error, 404, and 429 states.
3. **Merchant flow**
   - registration and sign-in;
   - wallet setup and replacement warning;
   - payment-link creation, amount conversion, and copy action.
4. **Customer account and embedded wallet, after backend prerequisites**
   - customer registration, login, session restoration, and return-to-payment;
   - embedded wallet provisioning, restoration, and recovery-required states;
   - Turnkey passkey authorization through the Senda adapter.
5. **Customer checkout**
   - public payment details and state rendering;
   - Pay without wallet connection or network selection;
   - exact direct EOA transaction submission through the Turnkey adapter;
   - clear USDC and Base ETH funding and insufficient-balance states;
   - confirmation polling and reload recovery.
6. **Receipt and polish**
   - accepted and review-required receipt views;
   - responsive layout, light/dark switch, and accessibility review;
   - complete focused tests and production build verification.

Suggested commit boundaries:

```text
feat: scaffold Senda web application
feat: add merchant payment-link flow
feat: add embedded customer wallet
feat: add one-tap USDC checkout
feat: add payment receipt interface
```

Each commit must follow `docs/commit-spec.md` and leave the repository buildable.

## MVP Acceptance Criteria

The frontend MVP is complete when:

- a new merchant can register, refresh, and remain signed in;
- a merchant can configure an external receiving address and create a valid
  payment link;
- the copied public link opens the correct payment without merchant auth;
- a customer can register or sign in and restore one embedded wallet without a
  connect-wallet step;
- a customer can review the exact Base/USDC payment before tapping Pay;
- tapping Pay invokes Turnkey-backed passkey or biometric authorization for that
  payment and does not silently treat login as spending approval;
- the Turnkey-backed EOA uses the backend transaction request exactly;
- the USDC balance, Base ETH balance, and gas requirement are clear before Pay;
- one transaction hash is submitted idempotently and survives page reload;
- every backend payment status has a distinct, understandable UI state;
- confirmation polling respects visibility, backoff, and rate-limit headers;
- a paid payment displays a stable receipt;
- a reorg-audited receipt displays `review_required` clearly;
- customer and merchant cookies, signing material, and private keys are never
  stored in browser JavaScript storage;
- light mode is the default and an accessible persisted theme switch works
  without a first-paint flash;
- mobile, keyboard, focus, contrast, and reduced-motion behavior are verified;
- unknown API routes remain JSON while web routes use the SPA fallback;
- root checks and the production container build include the web application.

## Explicitly Deferred

Do not add these to the first frontend implementation:

- logout until the backend exposes a real session-destruction endpoint;
- merchant payment history or receipt lists;
- payment editing, cancellation, refunds, or compensation;
- a connect-external-wallet customer flow as a substitute for embedded wallets;
- platform-custodied customer or merchant wallets;
- pre-authorized session-key spending unless separately specified and approved;
- EIP-3009 relaying, account abstraction, bundlers, and paymasters;
- Coinbase Wallet SDK, Coinbase connectors, OnchainKit, Base Account, or
  Coinbase API integrations;
- token approval flows;
- multiple chains or assets;
- FX, swaps, subscriptions, invoices, tax, or accounting exports;
- email or PDF receipts;
- push notifications or WebSocket confirmation updates;
- frontend access to security audit events;
- two-factor authentication or recovery UI before backend contracts exist.

Record newly discovered backend needs here instead of implementing client-only
workarounds.

## Confirmed and Pending Decisions

Confirmed choices:

1. use the dedicated `app` branch for frontend changes and commits;
2. scaffold `apps/web`, then apply the full `b1GwSVbE2` preset through shadcn's
   Existing Project workflow;
3. use Vite, React, strict TypeScript, React Router, and shadcn/ui with Base UI;
4. keep `/pay/:publicId` as the public payment URL;
5. use Inter with terracotta `#BA2D0B`, mint `#D5F2E3`, frosted turquoise
   `#73BA9B`, dark pine `#003E1F`, and forest black `#01110A`;
6. default to light mode and provide a persisted accessible light/dark switch;
7. build a compact product-facing landing page;
8. default new payment links to a 24-hour expiry;
9. provision and restore a Turnkey-backed embedded EOA after customer login,
   with no connect-wallet or network-selection step before Pay;
10. require an OS passkey or biometric confirmation for every payment;
11. use direct EOA transactions for the MVP and require the customer wallet to
    hold both USDC and Base ETH for gas;
12. keep merchant settlement on the existing external receiving-address model;
13. do not integrate Coinbase Wallet, Coinbase Wallet SDK, OnchainKit, Base
    Account, or Coinbase APIs;
14. use strong, actionable `review_required` language and follow the UI content
    standards above, including the prohibition on em dashes.

Customer identity, Turnkey validation, and funding prerequisites are tracked in
`docs/customer-payment-flow-plan.md` and are not UI tasks.

The only remaining visual decision is whether to replace the temporary text
wordmark when a logo or dedicated identity becomes available.
