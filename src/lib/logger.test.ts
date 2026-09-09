import { Writable } from "node:stream";

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createHttpLoggingMiddleware } from "../app.js";
import { createLogger } from "./logger.js";

describe("HTTP logging", () => {
  it("removes credential-bearing headers while retaining request metadata", async () => {
    const output: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });
    const testLogger = createLogger(destination, "info");
    const app = express();
    app.use(express.json());
    app.use(createHttpLoggingMiddleware(testLogger, true));
    app.post("/logged-request", (req, res) => {
      if (req.get("authorization") !== "Bearer request-authorization-sentinel") {
        res.sendStatus(401);
        return;
      }
      res.setHeader("set-cookie", "session=response-cookie-sentinel; HttpOnly");
      res.setHeader("www-authenticate", 'Bearer error="response-auth-sentinel"');
      res.status(202).json({ result: "response-body-sentinel" });
    });

    const response = await request(app)
      .post("/logged-request?probe=metadata")
      .set("cookie", "session=request-cookie-sentinel")
      .set("authorization", "Bearer request-authorization-sentinel")
      .set("proxy-authorization", "Basic proxy-authorization-sentinel")
      .set("x-api-key", "request-api-key-sentinel")
      .send({ privateValue: "request-body-sentinel" });

    expect(response.status).toBe(202);
    const serializedOutput = Buffer.concat(output).toString("utf8");
    expect(serializedOutput).not.toMatch(
      /request-cookie-sentinel|request-authorization-sentinel|proxy-authorization-sentinel|request-api-key-sentinel|response-cookie-sentinel|response-auth-sentinel|request-body-sentinel|response-body-sentinel/,
    );

    const entries = serializedOutput
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completed = entries.find((entry) => entry.msg === "request completed");
    expect(completed).toMatchObject({
      req: {
        id: expect.any(Number) as number,
        method: "POST",
        url: "/logged-request?probe=metadata",
        remoteAddress: expect.any(String) as string,
      },
      res: {
        statusCode: 202,
      },
      responseTime: expect.any(Number) as number,
    });
    expect(completed).not.toHaveProperty("req.headers");
    expect(completed).not.toHaveProperty("res.headers");
  });

  it("keeps credentials and bodies out of error-path logs", async () => {
    const output: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    });
    const testLogger = createLogger(destination, "info");
    const app = express();
    app.use(createHttpLoggingMiddleware(testLogger, true));
    app.get("/logged-error", (_req, _res, next) => {
      next(new Error("expected test failure"));
    });
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.setHeader("set-cookie", "session=error-response-cookie-sentinel; HttpOnly");
        res.status(500).json({ error: "error-response-body-sentinel" });
      },
    );

    const response = await request(app)
      .get("/logged-error")
      .set("cookie", "session=error-request-cookie-sentinel")
      .set("authorization", "Bearer error-request-authorization-sentinel");

    expect(response.status).toBe(500);
    const serializedOutput = Buffer.concat(output).toString("utf8");
    expect(serializedOutput).not.toMatch(
      /error-response-cookie-sentinel|error-response-body-sentinel|error-request-cookie-sentinel|error-request-authorization-sentinel/,
    );

    const entries = serializedOutput
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failed = entries.find(
      (entry) =>
        typeof entry.req === "object" &&
        entry.req !== null &&
        "url" in entry.req &&
        entry.req.url === "/logged-error",
    );
    expect(failed).toMatchObject({
      req: {
        id: expect.any(Number) as number,
        method: "GET",
        url: "/logged-error",
        remoteAddress: expect.any(String) as string,
      },
      res: {
        statusCode: 500,
      },
      responseTime: expect.any(Number) as number,
    });
    expect(failed).not.toHaveProperty("req.headers");
    expect(failed).not.toHaveProperty("res.headers");
  });
});
