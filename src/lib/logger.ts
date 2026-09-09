import pino, { type DestinationStream, type LevelWithSilent } from "pino";

import { env } from "../config/env.js";

const httpHeaderRedaction = {
  paths: ["req.headers", "res.headers"],
  remove: true,
};

export function createLogger(
  destination?: DestinationStream,
  level: LevelWithSilent = env.NODE_ENV === "test" ? "silent" : "info",
) {
  const options = {
    level,
    redact: httpHeaderRedaction,
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
