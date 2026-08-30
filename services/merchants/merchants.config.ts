import { betterAuth } from "better-auth";

import { env } from "../../src/config/env.js";
import { getDb } from "../../src/lib/db.js";

function buildMerchantAuth() {
  return betterAuth({
    database: {
      db: getDb(),
      type: "postgres",
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    session: {
      freshAge: env.MERCHANT_SESSION_FRESH_AGE_SECONDS,
    },
    emailAndPassword: {
      enabled: true,
    },
  });
}

let instance: ReturnType<typeof buildMerchantAuth> | undefined;

export function getMerchantAuth(): ReturnType<typeof buildMerchantAuth> {
  instance ??= buildMerchantAuth();
  return instance;
}

/** Test-only: rebuild auth after the test database replaces the live DB. */
export function resetMerchantAuth(): void {
  instance = undefined;
}
