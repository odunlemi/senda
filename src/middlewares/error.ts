import { APIError as BetterAuthAPIError } from "better-auth";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { logger } from "../lib/logger.js";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors.js";

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

  if (err instanceof NotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }

  if (err instanceof ConflictError) {
    res.status(409).json({ success: false, error: err.message });
    return;
  }

  if (err instanceof BetterAuthAPIError) {
    res.status(err.statusCode).json({ success: false, error: err.message });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({ success: false, error: "Internal server error" });
};
