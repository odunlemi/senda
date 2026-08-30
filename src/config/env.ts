import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  BASE_RPC_URL: z.url().default("https://mainnet.base.org"),
  CHECKOUT_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),
  RATE_LIMIT_IP_AUTH_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_IP_AUTH_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_IP_PUBLIC_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_IP_PUBLIC_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),
  RATE_LIMIT_IP_RPC_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_IP_RPC_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),
  RATE_LIMIT_MERCHANT_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_MERCHANT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),
  MERCHANT_SESSION_FRESH_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60),
});

export const env = envSchema.parse(process.env);
