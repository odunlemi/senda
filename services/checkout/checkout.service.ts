import { paymentConfig } from "../../src/config/payment.js";
import { getDb } from "../../src/lib/db.js";
import { badRequest, notFound } from "../../src/lib/errors.js";
import { toPublicPaymentIntent } from "../payment-intents/payment-intents.service.js";
import type { PaymentIntentRow } from "../payment-intents/payment-intents.types.js";
import { getBaseTransactionProvider } from "./checkout.provider.js";

const transferSelector = "a9059cbb";

function encodeUsdcTransfer(destinationAddress: string, amountAtomic: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(destinationAddress)) {
    badRequest("Payment link has an invalid destination address");
  }
  const destination = destinationAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amount = BigInt(amountAtomic).toString(16).padStart(64, "0");
  return `0x${transferSelector}${destination}${amount}`;
}

function requireOpenPaymentIntent(row: PaymentIntentRow): void {
  if (row.expiresAt.getTime() <= Date.now()) badRequest("Payment link has expired");
  if (row.status !== "created" && row.status !== "awaiting_payment") {
    badRequest("Payment link is not available for checkout");
  }
}

async function requirePaymentIntent(publicId: string): Promise<PaymentIntentRow> {
  const row = await getDb()
    .selectFrom("paymentIntents")
    .selectAll()
    .where("publicId", "=", publicId)
    .executeTakeFirst();
  if (!row) notFound("Payment link not found");
  return row;
}

export async function prepareCheckout(publicId: string) {
  const paymentIntent = await requirePaymentIntent(publicId);
  if (paymentIntent.expiresAt.getTime() <= Date.now()) {
    await getDb()
      .updateTable("paymentIntents")
      .set({ status: "expired", updatedAt: new Date() })
      .where("id", "=", paymentIntent.id)
      .where("status", "in", ["created", "awaiting_payment"])
      .execute();
  }
  requireOpenPaymentIntent(paymentIntent);

  if (paymentIntent.status === "created") {
    await getDb()
      .updateTable("paymentIntents")
      .set({ status: "awaiting_payment", updatedAt: new Date() })
      .where("id", "=", paymentIntent.id)
      .where("status", "=", "created")
      .execute();
  }
  const row = await requirePaymentIntent(publicId);
  requireOpenPaymentIntent(row);

  return {
    paymentIntent: toPublicPaymentIntent(row),
    transactionRequest: {
      chainId: paymentConfig.chainId,
      to: paymentConfig.assetContractAddress,
      data: encodeUsdcTransfer(row.destinationAddress, row.amountAtomic),
      value: "0x0" as const,
    },
  };
}

export async function submitCheckoutTransaction(publicId: string, transactionHash: string) {
  const paymentIntent = await requirePaymentIntent(publicId);
  if (
    paymentIntent.transactionHash?.toLowerCase() === transactionHash.toLowerCase() &&
    (paymentIntent.status === "confirming" || paymentIntent.status === "paid")
  ) {
    return toPublicPaymentIntent(paymentIntent);
  }
  if (paymentIntent.expiresAt.getTime() <= Date.now()) {
    await getDb()
      .updateTable("paymentIntents")
      .set({ status: "expired", updatedAt: new Date() })
      .where("id", "=", paymentIntent.id)
      .where("status", "in", ["created", "awaiting_payment"])
      .execute();
    badRequest("Payment link has expired");
  }
  if (paymentIntent.status !== "awaiting_payment") {
    badRequest("Payment link is not awaiting payment");
  }

  const transaction = await getBaseTransactionProvider().getTransaction(transactionHash);
  if (!transaction) badRequest("Transaction not found on Base");

  const expectedInput = encodeUsdcTransfer(
    paymentIntent.destinationAddress,
    paymentIntent.amountAtomic,
  );
  if (
    transaction.hash.toLowerCase() !== transactionHash.toLowerCase() ||
    transaction.to?.toLowerCase() !== paymentConfig.assetContractAddress.toLowerCase() ||
    transaction.input.toLowerCase() !== expectedInput ||
    BigInt(transaction.value) !== 0n ||
    !/^0x[a-fA-F0-9]{40}$/.test(transaction.from)
  ) {
    badRequest("Transaction does not match this payment link");
  }

  const row = await getDb()
    .updateTable("paymentIntents")
    .set({
      status: "confirming",
      payerAddress: transaction.from,
      transactionHash,
      updatedAt: new Date(),
    })
    .where("id", "=", paymentIntent.id)
    .where("status", "=", "awaiting_payment")
    .returningAll()
    .executeTakeFirstOrThrow();

  return toPublicPaymentIntent(row);
}
