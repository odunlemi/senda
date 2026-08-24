import { Router } from "express";

import {
  createMerchant,
  createMerchantSession,
  readCurrentMerchant,
} from "./merchants.controller.js";
import { requireMerchantSession } from "./merchants.middleware.js";

export const merchantsRouter = Router();

merchantsRouter.post("/merchants", createMerchant);
merchantsRouter.post("/merchant-sessions", createMerchantSession);
merchantsRouter.get("/merchant-sessions/current", requireMerchantSession, readCurrentMerchant);
