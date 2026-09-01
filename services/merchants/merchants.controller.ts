import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler, Response } from "express";

import {
  createMerchantSchema,
  createMerchantSessionSchema,
  merchantWalletSchema,
  merchantWalletResponseSchema,
  merchantWalletChangeResponseSchema,
  merchantResponseSchema,
  merchantSessionResponseSchema,
} from "../../contracts/merchants.js";
import { getDb } from "../../src/lib/db.js";
import { notFound } from "../../src/lib/errors.js";
import { getMerchantAuth } from "./merchants.config.js";
import {
  cancelPendingWalletChange,
  getPendingWalletChange,
  setOrRequestMerchantWallet,
} from "./merchants.service.js";

function forwardAuthCookies(res: Response, headers: Headers): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
}

async function publicMerchant(user: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}) {
  const merchant = await getDb()
    .selectFrom("user")
    .select("receivingWalletAddress")
    .where("id", "=", user.id)
    .executeTakeFirstOrThrow();

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    receivingWalletAddress: merchant.receivingWalletAddress,
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
      data: { merchant: await publicMerchant(result.response.user) },
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
      data: { merchant: await publicMerchant(result.response.user) },
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
      data: { merchant: await publicMerchant(result.user) },
    }),
  );
};

export const setMerchantWallet: RequestHandler = async (req, res) => {
  const merchantId = req.merchantId;
  if (!merchantId) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  const body = merchantWalletSchema.parse(req.body);
  const result = await setOrRequestMerchantWallet(merchantId, body.receivingWalletAddress);

  if (result.kind === "immediate" || result.kind === "no-op") {
    res.status(200).json(
      merchantWalletResponseSchema.parse({
        success: true,
        data: { receivingWalletAddress: result.address },
      }),
    );
    return;
  }

  res.status(202).json(
    merchantWalletChangeResponseSchema.parse({
      success: true,
      data: {
        requestedAddress: result.request.requestedAddress,
        previousAddress: result.request.previousAddress,
        status: result.request.status,
        activationAt: result.request.activationAt.toISOString(),
        requestedAt: result.request.requestedAt.toISOString(),
        cancelledAt: result.request.cancelledAt?.toISOString(),
        appliedAt: result.request.appliedAt?.toISOString(),
      },
    }),
  );
};

function walletChangeResponse(request: {
  requestedAddress: string;
  previousAddress: string;
  status: "pending" | "cancelled" | "applied";
  requestedAt: Date;
  activationAt: Date;
  cancelledAt: Date | null;
  appliedAt: Date | null;
}) {
  return merchantWalletChangeResponseSchema.parse({
    success: true,
    data: {
      requestedAddress: request.requestedAddress,
      previousAddress: request.previousAddress,
      status: request.status,
      activationAt: request.activationAt.toISOString(),
      requestedAt: request.requestedAt.toISOString(),
      cancelledAt: request.cancelledAt?.toISOString(),
      appliedAt: request.appliedAt?.toISOString(),
    },
  });
}

export const readPendingWalletChange: RequestHandler = async (req, res) => {
  const merchantId = req.merchantId;
  if (!merchantId) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const request = await getPendingWalletChange(merchantId);
  if (!request) {
    notFound("No pending wallet change request");
    return;
  }

  res.status(200).json(walletChangeResponse(request));
};

export const cancelPendingWalletChangeController: RequestHandler = async (req, res) => {
  const merchantId = req.merchantId;
  if (!merchantId) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const request = await cancelPendingWalletChange(merchantId);
  res.status(200).json(walletChangeResponse(request));
};
