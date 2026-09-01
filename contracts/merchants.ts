import { z } from "zod";

export const createMerchantSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email(),
  password: z.string().min(8).max(128),
});

export const merchantResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    merchant: z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
      emailVerified: z.boolean(),
      receivingWalletAddress: z.string().nullable(),
    }),
  }),
});

export const createMerchantSessionSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const merchantSessionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    merchant: merchantResponseSchema.shape.data.shape.merchant,
  }),
});

export const merchantWalletSchema = z.object({
  receivingWalletAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid receiving wallet address"),
});

export const merchantWalletResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    receivingWalletAddress: z.string(),
  }),
});

export const merchantWalletChangeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    requestedAddress: z.string(),
    previousAddress: z.string(),
    status: z.enum(["pending", "cancelled", "applied"]),
    activationAt: z.iso.datetime(),
    requestedAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().optional(),
    appliedAt: z.iso.datetime().optional(),
  }),
});
