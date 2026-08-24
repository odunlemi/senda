# Senda Backend Plan

Senda's first version should make accepting a crypto payment feel as close
to a payment link as possible. The product is deliberately smaller than a
general-purpose crypto gateway.

## Product Shape

There are two audiences:

- A business signs in, gets one receiving wallet, and creates a payment link
  or embeddable payment button.
- A customer opens the link in Senda, connects or uses their wallet, reviews
  the payment, and explicitly approves the transaction.

After the transaction is confirmed, Senda shows the payment status and gives
both sides a receipt containing the blockchain transaction hash.

The first release is a one-time payment product. `Pay` is in scope. A real
`Subscribe` button is not: recurring crypto payments require a separate
authorization and signing model.

## MVP Boundaries

Keep the first payment path narrow:

- one blockchain;
- one stablecoin;
- one business receiving wallet;
- Senda-initiated checkout only;
- payment in the same asset that the business requests;
- no FX execution or cross-chain swaps;
- no arbitrary external-wallet transfers;
- no subscription billing;
- no pooled merchant balance or treasury product.

The chain and stablecoin should be chosen before implementation and treated
as explicit configuration, not as an invitation to support every chain.

Customers may have an embedded Senda wallet if that is required for the
seamless checkout experience. They still explicitly approve each payment.
Being signed in removes repeated login friction; it does not silently grant
Senda permission to spend funds.

## Payment Model

Do not start with a full accounting-oriented invoice system. A payment link
is a payment intent with optional invoice-style metadata:

- merchant;
- requested amount and asset;
- chain;
- description or reference;
- expiry time;
- payer wallet;
- transaction hash;
- payment status.

Add line items, tax fields, invoice numbering, exports, and reconciliation
workflows only when businesses need them.

## Checkout Flow

1. The business creates a payment intent and receives a stable public link.
2. The customer opens the link in the Senda web UI.
3. Senda displays the exact amount, asset, destination, and expiry.
4. The customer signs or approves the transaction in their wallet.
5. Senda records the transaction hash and waits for the required confirmation.
6. The payment intent becomes paid and receipts are available to both sides.

The backend constructs the expected transaction and verifies the submitted
transaction against that intent. Unrelated transfers to the shared business
wallet must not be guessed into a payment link: without a guided checkout,
two payments with the same amount are inherently ambiguous.

## State Model

The user-facing state model stays small:

```text
created -> awaiting_payment -> confirming -> paid
                       \\-> expired

confirming -> failed
```

The persistence model still needs operational fields for provider event IDs,
idempotency keys, transaction hashes, confirmation counts, retries, and error
details. A simple UI must not require a careless backend.

Before supporting external transfers or different assets, define explicit
states for underpayment, overpayment, settlement failure, and reorg handling.

## Wallet and Custody

The wallet decision must be explicit before implementation:

- An embedded wallet can provide the smoothest customer experience, but it
  requires a recovery and device-security story.
- A backend-signed wallet makes the flow easy to automate but is
  platform-controlled custody or operational custody, even when balances are
  not pooled.
- Bring-your-own-wallet reduces Senda's custody responsibility but adds
  connection and signing friction.

Senda should document who controls keys, who can initiate a payment, how
wallet recovery works, and what happens if the wallet provider or backend is
compromised. Two-factor authentication is most valuable for account recovery,
wallet changes, payout changes, and unusually large payments.

## Defer FX and Swaps

The Wise FX widget can display a fiat estimate, but the MVP should not execute
FX. Settlement should remain in the requested stablecoin on the selected
chain. Cross-asset and cross-chain swaps add quote expiry, slippage, gas,
routing failures, retries, compliance, and reconciliation concerns.

Add swaps only after the direct payment path is reliable and there is a clear
settlement requirement that justifies the extra state and operational work.

## Monorepo Deployment

The frontend and API should live in one repository and ship from one
deployment and one origin when the web UI is added. This removes unnecessary
CORS and cross-service cookie configuration, keeps payment-link routing in one
place, and gives the first release one build and deploy pipeline.

The backend foundation remains useful in this shape: Express, Postgres and
Kysely, authentication, migrations, structured logging, tests, Docker, and
Railway deployment. Separate frontend hosting, cross-origin configuration,
provider adapters, swap routing, and wallet-per-invoice infrastructure are not
required for the MVP.

## Delivery Order

1. Select the chain and stablecoin.
2. Establish the merchant account and wallet ownership model.
3. Create payment intents and public links.
4. Build the guided checkout and transaction approval flow.
5. Verify confirmations and make reconciliation idempotent.
6. Generate receipts for the business and customer.
7. Add rate limits, audit events, recovery controls, and operational alerts.

Only after this path works should Senda consider external-wallet payments,
additional assets, FX, swaps, subscriptions, or a full invoice/accounting
surface.
