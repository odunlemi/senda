import { z } from "zod";

export const paymentReceiptSchema = z.object({
  publicPaymentId: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  asset: z.literal("USDC"),
  chain: z.literal("base"),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  payerAddress: z.string(),
  destinationAddress: z.string(),
  transactionHash: z.string(),
  confirmationCount: z.number().int().nonnegative(),
  paidAt: z.iso.datetime(),
  settlement: z.enum(["accepted", "review_required"]),
});

export const paymentReceiptResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ receipt: paymentReceiptSchema }),
});

export type PaymentReceipt = z.infer<typeof paymentReceiptSchema>;
