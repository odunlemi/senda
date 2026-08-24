import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";

import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middlewares/error.js";
import { notFound } from "./middlewares/notFound.js";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(express.json());
  app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== "test" }));

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ success: true, data: { status: "ok" } });
  });

  // Routers mount here as steps land:
  // app.use("/api", authRouter);
  // app.use("/api", paymentIntentsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
