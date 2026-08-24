import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler, Response } from "express";

import {
  createMerchantSchema,
  createMerchantSessionSchema,
  merchantResponseSchema,
  merchantSessionResponseSchema,
} from "../../contracts/merchants.js";
import { getMerchantAuth } from "./merchants.config.js";

function forwardAuthCookies(res: Response, headers: Headers): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
}

function publicMerchant(user: { id: string; name: string; email: string; emailVerified: boolean }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
  };
}

export const createMerchant: RequestHandler = async (req, res) => {
  const body = createMerchantSchema.parse(req.body);
  const result = await getMerchantAuth().api.signUpEmail({
    headers: fromNodeHeaders(req.headers),
    body,
    returnHeaders: true,
  });

  forwardAuthCookies(res, result.headers);
  res.status(201).json(
    merchantResponseSchema.parse({
      success: true,
      data: { merchant: publicMerchant(result.response.user) },
    }),
  );
};

export const createMerchantSession: RequestHandler = async (req, res) => {
  const body = createMerchantSessionSchema.parse(req.body);
  const result = await getMerchantAuth().api.signInEmail({
    headers: fromNodeHeaders(req.headers),
    body,
    returnHeaders: true,
  });

  forwardAuthCookies(res, result.headers);
  res.status(201).json(
    merchantSessionResponseSchema.parse({
      success: true,
      data: { merchant: publicMerchant(result.response.user) },
    }),
  );
};

export const readCurrentMerchant: RequestHandler = async (req, res) => {
  const result = await getMerchantAuth().api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!result) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  res.status(200).json(
    merchantResponseSchema.parse({
      success: true,
      data: { merchant: publicMerchant(result.user) },
    }),
  );
};
