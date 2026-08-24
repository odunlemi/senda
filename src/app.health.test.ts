import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

const app = createApp();

describe("GET /api/health", () => {
  it("reports ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: "ok" } });
  });

  it("sets security headers via helmet", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("unmatched route", () => {
  it("returns a JSON 404", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found" });
  });
});
