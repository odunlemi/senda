import { z } from "zod";

import { publicPaymentIntentSchema } from "./payment-intents.js";

export const transactionHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/i, "Invalid transaction hash");

export const submitCheckoutTransactionSchema = z.object({
  transactionHash: transactionHashSchema,
});

export const checkoutTransactionRequestSchema = z.object({
  chainId: z.literal(8453),
  to: z.literal("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  data: z.string().regex(/^0x[a-f0-9]+$/),
  value: z.literal("0x0"),
});

export const checkoutResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    paymentIntent: publicPaymentIntentSchema,
    transactionRequest: checkoutTransactionRequestSchema,
  }),
});

export const submittedCheckoutResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ paymentIntent: publicPaymentIntentSchema }),
});
