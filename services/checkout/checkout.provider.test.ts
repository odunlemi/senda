import { afterEach, describe, expect, it, vi } from "vitest";

import { paymentConfig } from "../../src/config/payment.js";
import { JsonRpcBaseTransactionProvider } from "./checkout.provider.js";

describe("Base transaction provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an RPC endpoint connected to another chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    const provider = new JsonRpcBaseTransactionProvider();
    await expect(provider.getCurrentBlockNumber()).rejects.toThrow(
      `Base RPC chain mismatch; expected chain ${paymentConfig.chainId}`,
    );
  });

  it("validates Base chain identity before reading RPC data", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
      const request = JSON.parse(init.body) as { method: string };
      const result = request.method === "eth_chainId" ? "0x2105" : "0x64";
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new JsonRpcBaseTransactionProvider();
    await expect(provider.getCurrentBlockNumber()).resolves.toBe(100);
    await expect(provider.getCurrentBlockNumber()).resolves.toBe(100);

    const methods = fetchMock.mock.calls.map(([, init]) => {
      if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
      const request = JSON.parse(init.body) as { method: string };
      return request.method;
    });
    expect(methods.filter((method) => method === "eth_chainId")).toHaveLength(1);
  });
});
