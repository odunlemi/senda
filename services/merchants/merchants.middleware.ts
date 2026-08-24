import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler } from "express";

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
