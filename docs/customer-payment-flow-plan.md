# Senda Customer Payment Flow Backend Plan

## How to Use This Document

This is the backend handoff for the no-connect customer payment flow.

The implementation session should:

1. use the dedicated `flow` branch for all changes and commits;
2. verify the active branch before changing files;
3. keep UI implementation out of this branch;
4. read `docs/backend-plan.md`, `docs/frontend-plan.md`, and
   `docs/commit-spec.md` before implementation;
5. treat the wallet and custody decisions below as fixed MVP requirements;
6. implement the work in small, independently verified commits;
7. merge completed backend contracts into the `app` branch before customer
   checkout UI work begins.

Do not commit provider credentials, passkey material, private keys, production
wallet identifiers, or proof-of-concept secrets.

## Fixed Product and Security Decisions

- Merchants keep the existing external Base receiving-address model.
- Customers use one Turnkey-backed embedded EOA attached to their Senda account.
- Customer checkout has no connect-wallet or network-selection step.
- Every payment requires an OS passkey or biometric confirmation.
- Login restores the customer and wallet but does not authorize spending.
- The MVP sends the existing direct Base USDC transaction.
- The customer wallet must hold USDC and enough Base ETH for gas.
- Senda must not hold customer or merchant private keys.
- Senda must not be able to sign customer transactions unilaterally.
- Coinbase Wallet, Coinbase Wallet SDK, OnchainKit, Base Account, and Coinbase
  APIs are excluded.
- EIP-3009 relaying, account abstraction, bundlers, paymasters, and delegated
  session-key spending are deferred.

The customer UX and UI requirements are defined in
`docs/frontend-plan.md`. This document owns only backend architecture,
contracts, persistence, authorization, provider boundaries, and operations.

## Current Backend Baseline

The repository already provides:

- merchant registration, sign-in, sessions, and receiving-wallet configuration;
- canonical merchant wallet storage and durable wallet-change audit events;
- Base/USDC payment intents and public payment links;
- exact direct-transfer checkout request construction;
- transaction-hash validation and idempotent association;
- receipt, transfer-log, confirmation, timeout, and reorg reconciliation;
- paid payment receipts;
- route-aware rate limits;
- durable merchant-wallet and reorg audit events.

The repository does not yet provide:

- customer registration or sessions;
- customer and merchant role isolation;
- customer wallet persistence or Turnkey provisioning;
- customer passkey, device, or recovery lifecycle;
- customer USDC or Base ETH balances;
- payment-intent ownership by a customer;
- validation that the transaction payer is the authenticated customer's wallet;
- customer wallet audit events or provider operational procedures.

## Delivery Principles

- Keep the direct merchant settlement model unchanged.
- Preserve existing public payment-link and receipt privacy boundaries.
- Add forward migrations rather than rewriting applied migrations.
- Make provisioning and payment binding idempotent.
- Keep application database changes atomic with audit events.
- Treat provider calls as fallible and recover partial external success safely.
- Store provider identifiers and public addresses only.
- Keep Turnkey signing authorization on the customer side of the trust boundary.
- Do not weaken existing transaction verification to accommodate the provider.
- Stop and document a blocker if the proof of concept invalidates an assumption.

## Work Package 1: Turnkey Architecture Proof of Concept

Complete a disposable proof of concept before adding production schema.

### Questions to Prove

- Can a customer create and restore an isolated Turnkey organization and EOA
  from an ordinary Android browser in Nigeria?
- Can a passkey authorize a direct Base EOA transaction without Senda holding a
  signing credential?
- Can the resulting transaction preserve the current verifier shape: customer
  EOA as `from`, Base USDC contract as `to`, exact transfer calldata, and zero
  native value?
- What browser-safe project identifiers and allowed-origin settings are needed?
- Which operations require server credentials, and can those credentials ever
  authorize a customer transaction?
- How do device addition, account recovery, and wallet export work?
- What happens when Turnkey is unavailable after provisioning or during signing?
- What are the regional availability, pricing, rate-limit, and data-handling
  constraints?

### Proof-of-Concept Rules

- Use test wallets and Base Sepolia or non-spending signatures first.
- Do not use production customer funds.
- Keep secrets outside the repository.
- Do not retain disposable provider organizations after the evaluation.
- Record only architecture findings and sanitized request/response shapes.
- Verify Android passkey behavior from Nigeria rather than assuming global demo
  behavior applies.

### Exit Criteria

Proceed only if:

- the customer alone can authorize fund-moving signatures;
- Senda cannot sign with a backend credential;
- a direct EOA transaction matches the current checkout verifier;
- passkey enrollment and recovery work in the target mobile environment;
- wallet export or a credible provider exit path exists;
- provider outage behavior can be presented and recovered safely.

If these criteria fail, stop before production schema work and revise the
provider or gas architecture explicitly.

## Work Package 2: Customer Identity and Session Boundary

Add customer authentication without allowing customer sessions to pass merchant
authorization.

### Identity Model Decision

Choose and document one model before migration work:

1. one Better Auth identity with explicit merchant and customer roles or
   profiles; or
2. separate customer and merchant identity boundaries with distinct sessions.

The selected model must allow a person to become both a merchant and a customer
later without privilege confusion. Do not infer merchant privileges merely from
having a row in Better Auth's `user` table.

### Required Behavior

- Add customer registration, sign-in, current-session, sign-out, and recovery
  contracts.
- Add `requireCustomerSession` middleware.
- Make `requireMerchantSession` verify merchant authorization explicitly.
- Use HTTP-only, secure, same-origin cookies.
- Preserve generic credential and recovery responses that do not enumerate
  accounts.
- Reuse or extend the strict authentication rate-limit policy.
- Revoke or rotate sessions according to Better Auth guidance after recovery.
- Preserve existing merchant IDs and payment ownership through forward
  migrations.

### Required Tests

- A customer session cannot configure a merchant wallet.
- A customer session cannot create merchant payment links.
- A merchant session cannot access another customer's wallet.
- An unauthenticated request cannot access customer wallet endpoints.
- Sign-out invalidates the active customer session.
- Recovery does not grant merchant privileges or change wallet ownership.
- One identity with both roles, if supported, is checked by the correct
  middleware for each route.

## Work Package 3: Embedded Wallet Persistence

Add a customer wallet table after the proof of concept fixes the provider data
model.

### Minimum Stored Fields

- application wallet-record ID;
- customer identity ID;
- Turnkey organization ID;
- Turnkey wallet or account ID;
- canonical Base EOA address;
- lifecycle status;
- safe provider activity or idempotency identifier when required;
- created and updated timestamps.

Suggested lifecycle states should reflect demonstrated provider behavior, not
speculation. At minimum distinguish provisioning, active, recovery required,
and unavailable if those states can occur independently.

### Persistence Rules

- One active embedded wallet per customer for the MVP.
- Unique Turnkey organization and wallet identifiers.
- Case-insensitive unique Base addresses.
- No private keys, passkey secrets, credential material, session tokens, export
  bundles, or provider API secrets.
- No public endpoint accepts a customer ID or wallet address to select another
  customer's wallet.
- Source-record deletion must not erase required security audit history.

Use a forward migration and add Kysely types without changing existing merchant
wallet semantics.

## Work Package 4: Idempotent Turnkey Provisioning

Add authenticated provisioning and read services after persistence exists.

### Provisioning Requirements

- Bind provisioning to the authenticated customer.
- Accept or generate an idempotency key for retry safety.
- Lock or conditionally transition the customer wallet record before external
  provider creation.
- Prevent concurrent requests from creating multiple wallets.
- Bind allowed browser origins and the customer's passkey according to the
  verified Turnkey protocol.
- Return only the public Base address and lifecycle state.
- Recover when Turnkey succeeds but the local database write fails.
- Recover when the local reservation succeeds but Turnkey fails or times out.
- Do not mark a wallet active until its address and customer binding are
  verified.

### Suggested API Surface

Finalize paths after the proof of concept, but keep the capability shape small:

- provision the current customer's wallet;
- read the current customer's wallet and lifecycle state;
- begin a demonstrated recovery or device-addition flow;
- complete a demonstrated recovery or device-addition flow.

Do not expose Turnkey organization IDs, internal activity IDs, credentials, or
raw provider errors to the browser unless a specific browser-safe value is
required by the verified SDK protocol.

### Audit Events

Extend the durable audit event model only for implemented state changes, such as:

- customer wallet provisioning completed;
- trusted device added;
- recovery started;
- recovery completed;
- wallet marked unavailable.

Keep application state changes and corresponding audit inserts atomic. Provider
operations that cannot share the database transaction need an explicit durable
state machine and retry procedure.

## Work Package 5: Passkey, Device, and Recovery Lifecycle

Define the lifecycle demonstrated by the proof of concept.

### Required Security Properties

- Initial wallet creation requires customer-controlled passkey enrollment.
- Every fund-moving signature requires the customer's passkey or OS biometric.
- Login alone cannot authorize a transaction.
- Adding a device requires recent customer authentication and existing recovery
  authority.
- Recovery cannot silently replace the wallet address.
- Recovery cannot give Senda unilateral signing authority.
- Device and recovery changes are rate-limited and audited.
- Losing one device has a documented path that does not depend on a Senda-held
  private key.
- Provider lockout or outage has a customer-visible state and operator procedure.

Do not invent recovery endpoints until Turnkey's supported challenge and
credential flow is verified. Do not store a recovery secret in the application
database.

## Work Package 6: Balance and Funding APIs

The direct EOA needs both Base USDC and Base ETH.

### Provider Extension

Extend the validated Base provider with narrowly typed reads for:

- native ETH balance through `eth_getBalance`;
- Base USDC balance through `balanceOf` using `eth_call`;
- current block or observation timestamp needed to describe freshness.

Reuse chain identity validation. Validate returned hex and numeric values and
never accept an arbitrary balance address from the client.

### Customer API

Add an authenticated, rate-limited endpoint that reads balances only for the
current customer's mapped wallet and returns:

- canonical wallet address;
- ETH balance in wei;
- USDC balance in six-decimal atomic units;
- observation time or block number.

The frontend may display the address and a funding QR code. Fiat on-ramp,
bridges, swaps, gas sponsorship, and treasury transfers are out of scope.

### Required Tests

- Only the mapped customer address reaches the provider.
- Another customer's address cannot be selected through input.
- Wrong-chain and malformed provider responses fail safely.
- USDC and ETH units remain exact strings without floating-point conversion.
- Rate-limited requests do not call the provider.
- Provider failures do not mutate wallet state.

## Work Package 7: Bind Checkout to the Customer Wallet

Keep payment details publicly readable, but require customer authentication when
Pay begins.

### Persistence

Add a nullable customer identity or equivalent payer binding to payment intents
through a forward migration. Index it for customer support and future payment
history without exposing it publicly.

### Checkout Rules

- Public `GET /api/payment-links/:publicId` remains available.
- Checkout preparation requires a valid customer session and active embedded
  wallet.
- The first preparation binds the payment intent to that customer and wallet
  idempotently.
- A different customer cannot take over a bound intent.
- Repeated preparation by the bound customer returns the same payment facts.
- Submitted transaction `from` must equal the customer's mapped EOA.
- Submitted transaction `to`, calldata, amount, merchant destination, native
  value, and transaction hash must retain existing exact validation.
- Existing transaction-hash uniqueness, receipt validation, confirmation,
  timeout, reorg, and receipt behavior remain intact.
- Customer IDs and Turnkey identifiers never appear in public payment or receipt
  responses.

Decide explicitly whether legacy unbound payment links remain payable during a
migration window. Do not silently change already-created payment destinations.

### Concurrency and Failure Tests

- Two customers race to prepare one link and only one binding wins.
- The winning customer can retry safely.
- Another customer receives a consistent conflict response.
- A transaction from a different EOA is rejected.
- A matching transaction from the mapped EOA follows the existing state machine.
- Session loss before submission does not let another customer replace the
  binding.
- Public status and receipt responses omit customer and Turnkey identifiers.

## Work Package 8: Turnkey Transaction Authorization Boundary

Turnkey signs on behalf of the customer only after explicit passkey approval.
Senda remains the source of payment facts and the verifier of the resulting
transaction.

### Backend Responsibilities

- Return the exact existing checkout request only to the bound customer.
- Include no backend signing credential in the response.
- Bind any safe provider activity identifier to the customer, wallet, and
  payment intent if the proof of concept requires one.
- Reject altered chain, contract, calldata, amount, destination, or native value.
- Accept one resulting transaction hash idempotently.
- Prevent repeated Pay actions from creating different transfers for one intent.
- Record only safe provider references needed for support and retries.
- Keep provider errors redacted and mapped to stable application errors.

### Trust Boundary

- Customer login proves application identity.
- Turnkey passkey approval authorizes the blockchain signature.
- The current Base verifier proves the broadcast transaction matches the payment
  intent.
- No single application session, backend credential, or provider webhook may
  replace all three checks.

Do not add session keys, delegated limits, a relayer, paymaster, backend
co-signing, or a fallback external-wallet connection.

## Work Package 9: Operational Hardening

Before enabling production wallet creation:

- add route-aware budgets for customer auth, provisioning, balance reads,
  passkey/device changes, recovery, and customer-bound checkout;
- verify signatures and replay protection for any Turnkey webhooks used;
- keep provider credentials in the server environment and secrets manager;
- restrict browser-safe provider projects to approved origins;
- redact provider errors and never log signing material;
- define alerts for repeated provisioning failures, recovery failures, provider
  outages, and payer-binding violations;
- define manual support procedures that do not ask customers for private keys or
  passkey secrets;
- document how to pause new provisioning without disrupting existing wallet
  access;
- document provider exit and wallet export procedures.

Use durable audit events for concrete lifecycle changes. Do not create broad
metadata dumps or store provider responses verbatim.

## Verification Matrix

The backend flow is ready for the `app` branch only when tests cover:

- merchant and customer authorization isolation;
- registration, current session, sign-out, and recovery behavior;
- idempotent wallet provisioning and uniqueness;
- concurrent provisioning;
- partial provider success and retry recovery;
- passkey-required signing and rejected authorization;
- device and recovery state transitions;
- exact USDC and ETH balance reads for the mapped wallet;
- checkout customer binding and race handling;
- payer-address enforcement;
- exact transaction integrity checks;
- repeated Pay and transaction submission safety;
- public response privacy;
- audit event atomicity and metadata redaction;
- rate limits that prevent rejected requests from reaching providers;
- Turnkey and Base RPC failure behavior.

For each production work package, run:

```text
pnpm check
pnpm build
git diff --check
```

Run the narrowest affected tests while iterating. Do not claim the Turnkey proof
of concept passed without testing the target Nigerian Android environment.

## Suggested Commit Sequence

```text
docs: record Turnkey flow findings
feat: add customer account boundary
feat: persist embedded customer wallets
feat: provision Turnkey customer wallets
feat: add customer wallet recovery states
feat: add customer wallet balances
feat: bind checkout to customer wallets
feat: enforce embedded wallet payments
```

Adjust boundaries if the verified Turnkey protocol requires a different split,
but keep each commit independently buildable and follow `docs/commit-spec.md`.

## Explicitly Out of Scope

- frontend components, routes, styling, or theme work;
- merchant embedded wallets;
- platform custody of customer or merchant funds;
- external connect-wallet customer checkout;
- Coinbase Wallet, Coinbase SDKs, OnchainKit, Base Account, or Coinbase APIs;
- EIP-3009 relaying;
- ERC-4337 smart accounts, bundlers, or paymasters;
- gas sponsorship;
- delegated or session-key spending;
- fiat on-ramps, swaps, bridges, or FX;
- multiple chains or assets;
- subscriptions, refunds, or compensation;
- production secrets or real-fund proof-of-concept transactions.

## Handoff to the App Branch

After each backend contract is committed and verified:

1. document its request, response, error, and authentication behavior;
2. merge or rebase the completed backend work into `app` according to the
   repository's normal workflow;
3. update `docs/frontend-plan.md` only where the verified backend differs from
   the planned contract;
4. keep incomplete provider experiments and credentials out of `app`;
5. do not enable the customer Pay UI until identity, wallet provisioning,
   balances, customer binding, and passkey authorization are all production
   ready.
