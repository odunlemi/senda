import { z } from "zod";

export const createPaymentIntentSchema = z.object({
  amountAtomic: z.string().regex(/^\d+$/),
  expiresAt: z.iso.datetime(),
  description: z.string().trim().min(1).max(500).optional(),
  reference: z.string().trim().min(1).max(200).optional(),
});

export const paymentIntentStatusSchema = z.enum([
  "created",
  "awaiting_payment",
  "confirming",
  "paid",
  "expired",
  "failed",
  "dropped",
]);

export const publicPaymentIntentSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  asset: z.literal("USDC"),
  chain: z.literal("base"),
  approvalRequired: z.literal(true),
  destinationAddress: z.string().min(1),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  status: paymentIntentStatusSchema,
  expiresAt: z.iso.datetime(),
  payerAddress: z.string().nullable(),
  transactionHash: z.string().nullable(),
  confirmationCount: z.number().int().nonnegative(),
});

export const publicPaymentIntentResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ paymentIntent: publicPaymentIntentSchema }),
});

export type PublicPaymentIntent = z.infer<typeof publicPaymentIntentSchema>;
