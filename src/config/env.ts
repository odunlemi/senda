import "dotenv/config";
import { z } from "zod";

const optionalEnvironmentValue = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

const envSchema = z
  .object({
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
    MERCHANT_WALLET_CHANGE_DELAY_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60),
    OPERATIONAL_ALERTS_MODE: z.enum(["disabled", "webhook"]).default("disabled"),
    OPERATIONAL_ALERT_WEBHOOK_URL: optionalEnvironmentValue(z.url()),
    OPERATIONAL_ALERT_WEBHOOK_TOKEN: optionalEnvironmentValue(z.string().min(16)),
    OPERATIONAL_ALERT_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    OPERATIONAL_ALERT_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(20),
    OPERATIONAL_ALERT_LEASE_MS: z.coerce.number().int().positive().default(60_000),
    OPERATIONAL_ALERT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    OPERATIONAL_ALERT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    OPERATIONAL_ALERT_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
    OPERATIONAL_ALERT_RETRY_MAX_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
  })
  .superRefine((value, context) => {
    if (value.OPERATIONAL_ALERTS_MODE !== "webhook") return;
    if (!value.OPERATIONAL_ALERT_WEBHOOK_URL) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONAL_ALERT_WEBHOOK_URL"],
        message: "Required when OPERATIONAL_ALERTS_MODE=webhook",
      });
    }
    if (!value.OPERATIONAL_ALERT_WEBHOOK_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONAL_ALERT_WEBHOOK_TOKEN"],
        message: "Required when OPERATIONAL_ALERTS_MODE=webhook",
      });
    }
    if (
      value.NODE_ENV === "production" &&
      value.OPERATIONAL_ALERT_WEBHOOK_URL &&
      new URL(value.OPERATIONAL_ALERT_WEBHOOK_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONAL_ALERT_WEBHOOK_URL"],
        message: "Must use HTTPS in production",
      });
    }
    if (value.OPERATIONAL_ALERT_RETRY_MAX_MS < value.OPERATIONAL_ALERT_RETRY_BASE_MS) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONAL_ALERT_RETRY_MAX_MS"],
        message: "Must be at least OPERATIONAL_ALERT_RETRY_BASE_MS",
      });
    }
    if (value.OPERATIONAL_ALERT_LEASE_MS <= value.OPERATIONAL_ALERT_TIMEOUT_MS) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONAL_ALERT_LEASE_MS"],
        message: "Must exceed OPERATIONAL_ALERT_TIMEOUT_MS",
      });
    }
  });

export function parseEnvironment(environment: NodeJS.ProcessEnv) {
  return envSchema.parse(environment);
}

export const env = parseEnvironment(process.env);
