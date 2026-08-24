import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { logger } from "../lib/logger.js";

export class BadRequestError extends Error {}

/** Throw from a controller; caught by errorHandler below. */
export function badRequest(message: string): never {
  throw new BadRequestError(message);
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ success: false, error: err.issues.map((issue) => issue.message).join(", ") });
    return;
  }

  if (err instanceof BadRequestError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({ success: false, error: "Internal server error" });
};
