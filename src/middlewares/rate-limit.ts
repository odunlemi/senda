import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import type { Options } from "express-rate-limit";

import { env } from "../config/env.js";

// The in-memory store works for the current single-process deployment. Before
// running multiple API instances, replace it with a shared external store such
// as Redis; adding that store is out of scope for this change.

function rateLimitResponse(res: Response, windowMs: number): void {
  res
    .set("Retry-After", String(Math.ceil(windowMs / 1000)))
    .status(429)
    .json({ success: false, error: "Too many requests" });
}

const rateLimitHandler = (_req: Request, res: Response, _next: () => void, options: Options) => {
  rateLimitResponse(res, options.windowMs);
};

export const ipAuthRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_IP_AUTH_WINDOW_MS,
  max: () => env.RATE_LIMIT_IP_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const ipPublicRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_IP_PUBLIC_WINDOW_MS,
  max: () => env.RATE_LIMIT_IP_PUBLIC_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const ipRpcRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_IP_RPC_WINDOW_MS,
  max: () => env.RATE_LIMIT_IP_RPC_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const merchantRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_MERCHANT_WINDOW_MS,
  max: () => env.RATE_LIMIT_MERCHANT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.merchantId ?? "unknown",
  skip: (req) => !req.merchantId,
  handler: rateLimitHandler,
});
