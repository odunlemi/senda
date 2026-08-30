import type { RequestHandler } from "express";

import { paymentReceiptResponseSchema } from "../../contracts/receipts.js";
import { getPaymentReceipt } from "./receipts.service.js";

export const readPaymentReceipt: RequestHandler = async (req, res) => {
  const publicId = req.params.publicId;
  if (typeof publicId !== "string") {
    res.status(404).json({ success: false, error: "Payment link not found" });
    return;
  }

  const receipt = await getPaymentReceipt(publicId);
  res.status(200).json(
    paymentReceiptResponseSchema.parse({
      success: true,
      data: { receipt },
    }),
  );
};
