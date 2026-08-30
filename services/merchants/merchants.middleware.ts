import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler } from "express";

import { env } from "../../src/config/env.js";
import { getMerchantAuth } from "./merchants.config.js";

export const requireMerchantSession: RequestHandler = async (req, res, next) => {
  const result = await getMerchantAuth().api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!result) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  req.merchantId = result.user.id;
  next();
};

export const requireFreshMerchantSession: RequestHandler = async (req, res, next) => {
  const result = await getMerchantAuth().api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!result) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const session = result as {
    user: { id: string };
    createdAt?: Date;
    session?: { createdAt: Date };
  };
  const createdAt = session.createdAt ?? session.session?.createdAt;
  if (!createdAt) {
    res.status(403).json({ success: false, error: "Session is not fresh" });
    return;
  }

  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (ageMs > env.MERCHANT_SESSION_FRESH_AGE_SECONDS * 1000) {
    res.status(403).json({ success: false, error: "Session is not fresh" });
    return;
  }

  req.merchantId = result.user.id;
  next();
};
