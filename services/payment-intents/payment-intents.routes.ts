import { Router } from "express";

import { readPublicPaymentIntent } from "./payment-intents.controller.js";

export const paymentIntentsRouter = Router();

paymentIntentsRouter.get("/payment-links/:publicId", readPublicPaymentIntent);
