import type { RequestHandler } from "express";

import {
  createPaymentIntentSchema,
  publicPaymentIntentResponseSchema,
} from "../../contracts/payment-intents.js";
import { createPaymentIntent, getPublicPaymentIntent } from "./payment-intents.service.js";

export const createMerchantPaymentIntent: RequestHandler = async (req, res) => {
  const merchantId = req.merchantId;
  if (!merchantId) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const body = createPaymentIntentSchema.parse(req.body);
  const paymentIntent = await createPaymentIntent({
    merchantId,
    destinationAddress: body.destinationAddress,
    amountAtomic: body.amountAtomic,
    expiresAt: new Date(body.expiresAt),
    ...(body.description ? { description: body.description } : {}),
    ...(body.reference ? { reference: body.reference } : {}),
  });

  res.status(201).json(
    publicPaymentIntentResponseSchema.parse({
      success: true,
      data: { paymentIntent },
    }),
  );
};

export const readPublicPaymentIntent: RequestHandler = async (req, res) => {
  const publicId = req.params.publicId;
  if (typeof publicId !== "string") {
    res.status(404).json({ success: false, error: "Payment link not found" });
    return;
  }

  const paymentIntent = await getPublicPaymentIntent(publicId);

  if (!paymentIntent) {
    res.status(404).json({ success: false, error: "Payment link not found" });
    return;
  }

  res.status(200).json(
    publicPaymentIntentResponseSchema.parse({
      success: true,
      data: { paymentIntent },
    }),
  );
};
