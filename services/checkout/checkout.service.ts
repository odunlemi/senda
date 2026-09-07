import { paymentConfig } from "../../src/config/payment.js";
import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import type { Updateable } from "kysely";
import { badRequest, notFound } from "../../src/lib/errors.js";
import { logger } from "../../src/lib/logger.js";
import { toPublicPaymentIntent } from "../payment-intents/payment-intents.service.js";
import { getBaseTransactionProvider, type BaseTransactionReceipt } from "./checkout.provider.js";
import type {
  PaymentIntentRow,
  PaymentIntentStatus,
  PaymentIntentsTable,
} from "../payment-intents/payment-intents.types.js";

const transferSelector = "a9059cbb";
const transferEventSignature = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

export function hasMatchingTransferLog(
  receipt: BaseTransactionReceipt,
  paymentIntent: Pick<PaymentIntentRow, "payerAddress" | "destinationAddress" | "amountAtomic">,
): boolean {
  if (!paymentIntent.payerAddress) return false;

  const expectedFrom = `0x${paymentIntent.payerAddress.slice(2).padStart(64, "0")}`.toLowerCase();
  const expectedTo =
    `0x${paymentIntent.destinationAddress.slice(2).padStart(64, "0")}`.toLowerCase();
  const expectedValue =
    `0x${BigInt(paymentIntent.amountAtomic).toString(16).padStart(64, "0")}`.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== paymentConfig.assetContractAddress.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== transferEventSignature) continue;
    if (log.topics[1]?.toLowerCase() !== expectedFrom) continue;
    if (log.topics[2]?.toLowerCase() !== expectedTo) continue;
    if (log.data.toLowerCase() !== expectedValue) continue;
    if (log.removed) continue;
    return true;
  }

  return false;
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
    (paymentIntent.status === "confirming" ||
      paymentIntent.status === "paid" ||
      paymentIntent.status === "dropped")
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
    const submittedAt = await getDatabaseTime();
    const monitoringExpiresAt = new Date(submittedAt.getTime() + paymentConfig.droppedMonitoringMs);
    row = await getDb()
      .updateTable("paymentIntents")
      .set({
        status: "confirming",
        payerAddress: transaction.from.toLowerCase(),
        transactionHash: normalizedHash,
        submittedAt,
        monitoringExpiresAt,
        updatedAt: submittedAt,
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
      (current.status === "confirming" || current.status === "paid" || current.status === "dropped")
    ) {
      return toPublicPaymentIntent(current);
    }
    badRequest("Payment link is no longer awaiting payment");
  }

  return toPublicPaymentIntent(row);
}

export async function reconcileCheckout(publicId: string, options: { automated?: boolean } = {}) {
  let paymentIntent = await requirePaymentIntent(publicId);
  if (paymentIntent.status === "paid" || paymentIntent.status === "failed") {
    return toPublicPaymentIntent(paymentIntent);
  }
  if (
    (paymentIntent.status !== "confirming" && paymentIntent.status !== "dropped") ||
    !paymentIntent.transactionHash ||
    !paymentIntent.submittedAt ||
    !paymentIntent.monitoringExpiresAt
  ) {
    badRequest("Payment link is not awaiting confirmation");
  }
  const transactionHash = paymentIntent.transactionHash;
  const submittedAt = paymentIntent.submittedAt;
  const monitoringExpiresAt = paymentIntent.monitoringExpiresAt;

  const reconciliationStartedAt = await getDatabaseTime();
  if (
    paymentIntent.monitoringEscalatedAt === null &&
    reconciliationStartedAt.getTime() >= monitoringExpiresAt.getTime()
  ) {
    const row = await getDb()
      .updateTable("paymentIntents")
      .set({
        monitoringEscalatedAt: reconciliationStartedAt,
        updatedAt: reconciliationStartedAt,
      })
      .where("id", "=", paymentIntent.id)
      .where("status", "in", ["confirming", "dropped"])
      .where("monitoringEscalatedAt", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (row) {
      logger.warn({ publicId, transactionHash }, "unresolved payment monitoring escalated");
    }
    paymentIntent = row ?? (await requirePaymentIntent(publicId));
    if (paymentIntent.status === "paid" || paymentIntent.status === "failed") {
      return toPublicPaymentIntent(paymentIntent);
    }
  }

  if (options.automated && paymentIntent.monitoringEscalatedAt !== null) {
    return toPublicPaymentIntent(paymentIntent);
  }

  const provider = getBaseTransactionProvider();
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt?.blockNumber) {
    const now = await getDatabaseTime();
    if (
      paymentIntent.status === "confirming" &&
      now.getTime() - submittedAt.getTime() >= paymentConfig.confirmingTimeoutMs
    ) {
      const row = await getDb()
        .updateTable("paymentIntents")
        .set({ status: "dropped", updatedAt: now })
        .where("id", "=", paymentIntent.id)
        .where("status", "=", "confirming")
        .returningAll()
        .executeTakeFirst();
      return toPublicPaymentIntent(row ?? (await requirePaymentIntent(publicId)));
    }
    return toPublicPaymentIntent(paymentIntent);
  }
  if (receipt.transactionHash.toLowerCase() !== transactionHash) {
    throw new Error("Base RPC returned a receipt for the wrong transaction");
  }

  const blockNumber = Number.parseInt(receipt.blockNumber, 16);
  const currentBlockNumber = await provider.getCurrentBlockNumber();
  const confirmationCount = Math.max(0, currentBlockNumber - blockNumber + 1);
  const status = receipt.status?.toLowerCase();
  const hasTransferLog = hasMatchingTransferLog(receipt, paymentIntent);
  let nextStatus: PaymentIntentStatus;
  if (status === "0x0" || (status === "0x1" && !hasTransferLog)) {
    nextStatus = "failed";
  } else if (status === "0x1" && confirmationCount >= paymentConfig.requiredConfirmations) {
    nextStatus = "paid";
  } else {
    nextStatus = "confirming";
  }

  const reconciledAt = await getDatabaseTime();
  const values: Updateable<PaymentIntentsTable> = {
    status: nextStatus,
    confirmationCount,
    updatedAt: reconciledAt,
  };
  if (nextStatus === "paid") {
    values.paidAt = reconciledAt;
  }

  const row = await getDb()
    .updateTable("paymentIntents")
    .set(values)
    .where("id", "=", paymentIntent.id)
    .where("status", "in", ["confirming", "dropped"])
    .returningAll()
    .executeTakeFirst();

  return toPublicPaymentIntent(row ?? (await requirePaymentIntent(publicId)));
}
