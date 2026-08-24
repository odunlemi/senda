import type { RequestHandler } from "express";

import { publicPaymentIntentResponseSchema } from "../../contracts/payment-intents.js";
import { getPublicPaymentIntent } from "./payment-intents.service.js";

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
