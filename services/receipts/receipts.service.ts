import type { PaymentReceipt } from "../../contracts/receipts.js";
import { getDb } from "../../src/lib/db.js";
import { conflict, notFound } from "../../src/lib/errors.js";

export async function getPaymentReceipt(publicId: string): Promise<PaymentReceipt> {
  const row = await getDb()
    .selectFrom("paymentIntents")
    .selectAll()
    .where("publicId", "=", publicId)
    .executeTakeFirst();

  if (!row) {
    notFound("Payment link not found");
  }

  if (row.status !== "paid") {
    conflict("Payment is not yet paid");
  }

  if (!row.payerAddress || !row.transactionHash || !row.paidAt) {
    throw new Error("Paid payment is missing required receipt fields");
  }

  return {
    publicPaymentId: row.publicId,
    amountAtomic: row.amountAtomic,
    asset: row.asset,
    chain: row.chain,
    description: row.description,
    reference: row.reference,
    payerAddress: row.payerAddress,
    destinationAddress: row.destinationAddress,
    transactionHash: row.transactionHash,
    confirmationCount: row.confirmationCount,
    paidAt: row.paidAt.toISOString(),
    settlement: row.reorgDetectedAt ? "review_required" : "accepted",
  };
}
