import type { RequestHandler } from "express";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
};
