import type { RequestHandler } from "express";

import {
  checkoutResponseSchema,
  submitCheckoutTransactionSchema,
  submittedCheckoutResponseSchema,
} from "../../contracts/checkout.js";
import { prepareCheckout, submitCheckoutTransaction } from "./checkout.service.js";

export const createCheckout: RequestHandler = async (req, res) => {
  const publicId = String(req.params.publicId);
  const result = await prepareCheckout(publicId);
  res.status(200).json(checkoutResponseSchema.parse({ success: true, data: result }));
};

export const createCheckoutTransaction: RequestHandler = async (req, res) => {
  const publicId = String(req.params.publicId);
  const body = submitCheckoutTransactionSchema.parse(req.body);
  const paymentIntent = await submitCheckoutTransaction(publicId, body.transactionHash);
  res.status(200).json(
    submittedCheckoutResponseSchema.parse({
      success: true,
      data: { paymentIntent },
    }),
  );
};
