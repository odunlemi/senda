import type { RequestHandler } from "express";

import { submittedCheckoutResponseSchema } from "../../contracts/checkout.js";
import { reconcileCheckout } from "./checkout.service.js";

export const reconcileCheckoutTransaction: RequestHandler = async (req, res) => {
  const publicId = String(req.params.publicId);
  const paymentIntent = await reconcileCheckout(publicId);
  res.status(200).json(
    submittedCheckoutResponseSchema.parse({
      success: true,
      data: { paymentIntent },
    }),
  );
};
