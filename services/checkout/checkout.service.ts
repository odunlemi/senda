import { paymentConfig } from "../../src/config/payment.js";
import { getDb } from "../../src/lib/db.js";
import { badRequest, notFound } from "../../src/lib/errors.js";
import { toPublicPaymentIntent } from "../payment-intents/payment-intents.service.js";
import type { PaymentIntentRow } from "../payment-intents/payment-intents.types.js";
import { getBaseTransactionProvider } from "./checkout.provider.js";

const transferSelector = "a9059cbb";

function normalizeTransactionHash(transactionHash: string): string {
  return `0x${transactionHash.replace(/^0x/i, "").toLowerCase()}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

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
  const normalizedHash = normalizeTransactionHash(transactionHash);
  const paymentIntent = await requirePaymentIntent(publicId);
  if (
    paymentIntent.transactionHash === normalizedHash &&
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

  const existingPaymentIntent = await getDb()
    .selectFrom("paymentIntents")
    .select("publicId")
    .where("transactionHash", "=", normalizedHash)
    .executeTakeFirst();
  if (existingPaymentIntent && existingPaymentIntent.publicId !== publicId) {
    badRequest("Transaction is already associated with another payment link");
  }

  const transaction = await getBaseTransactionProvider().getTransaction(normalizedHash);
  if (!transaction) badRequest("Transaction not found on Base");

  const expectedInput = encodeUsdcTransfer(
    paymentIntent.destinationAddress,
    paymentIntent.amountAtomic,
  );
  if (
    transaction.hash.toLowerCase() !== normalizedHash ||
    transaction.to?.toLowerCase() !== paymentConfig.assetContractAddress.toLowerCase() ||
    transaction.input.toLowerCase() !== expectedInput ||
    BigInt(transaction.value) !== 0n ||
    !/^0x[a-fA-F0-9]{40}$/.test(transaction.from)
  ) {
    badRequest("Transaction does not match this payment link");
  }

  let row: PaymentIntentRow | undefined;
  try {
    row = await getDb()
      .updateTable("paymentIntents")
      .set({
        status: "confirming",
        payerAddress: transaction.from.toLowerCase(),
        transactionHash: normalizedHash,
        updatedAt: new Date(),
      })
      .where("id", "=", paymentIntent.id)
      .where("status", "=", "awaiting_payment")
      .returningAll()
      .executeTakeFirst();
  } catch (error) {
    if (isUniqueViolation(error)) {
      badRequest("Transaction is already associated with another payment link");
    }
    throw error;
  }

  if (!row) {
    const current = await requirePaymentIntent(publicId);
    if (
      current.transactionHash === normalizedHash &&
      (current.status === "confirming" || current.status === "paid")
    ) {
      return toPublicPaymentIntent(current);
    }
    badRequest("Payment link is no longer awaiting payment");
  }

  return toPublicPaymentIntent(row);
}

export async function reconcileCheckout(publicId: string) {
  const paymentIntent = await requirePaymentIntent(publicId);
  if (paymentIntent.status === "paid" || paymentIntent.status === "failed") {
    return toPublicPaymentIntent(paymentIntent);
  }
  if (paymentIntent.status !== "confirming" || !paymentIntent.transactionHash) {
    badRequest("Payment link is not awaiting confirmation");
  }

  const provider = getBaseTransactionProvider();
  const receipt = await provider.getTransactionReceipt(paymentIntent.transactionHash);
  if (!receipt?.blockNumber) {
    return toPublicPaymentIntent(paymentIntent);
  }
  if (receipt.transactionHash.toLowerCase() !== paymentIntent.transactionHash) {
    throw new Error("Base RPC returned a receipt for the wrong transaction");
  }

  const blockNumber = Number.parseInt(receipt.blockNumber, 16);
  const currentBlockNumber = await provider.getCurrentBlockNumber();
  const confirmationCount = Math.max(0, currentBlockNumber - blockNumber + 1);
  const status = receipt.status?.toLowerCase();
  const nextStatus =
    status === "0x0"
      ? "failed"
      : status === "0x1" && confirmationCount >= paymentConfig.requiredConfirmations
        ? "paid"
        : "confirming";

  const row = await getDb()
    .updateTable("paymentIntents")
    .set({ status: nextStatus, confirmationCount, updatedAt: new Date() })
    .where("id", "=", paymentIntent.id)
    .where("status", "=", "confirming")
    .returningAll()
    .executeTakeFirst();

  return toPublicPaymentIntent(row ?? (await requirePaymentIntent(publicId)));
}
