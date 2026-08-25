import { env } from "../../src/config/env.js";

export interface BaseTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
}

export interface BaseTransactionProvider {
  getTransaction(transactionHash: string): Promise<BaseTransaction | undefined>;
}

class JsonRpcBaseTransactionProvider implements BaseTransactionProvider {
  async getTransaction(transactionHash: string): Promise<BaseTransaction | undefined> {
    const response = await fetch(env.BASE_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [transactionHash],
      }),
    });
    if (!response.ok) throw new Error(`Base RPC request failed with status ${response.status}`);

    const body = (await response.json()) as {
      result?: BaseTransaction | null;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "Base RPC request failed");
    return body.result ?? undefined;
  }
}

let instance: BaseTransactionProvider = new JsonRpcBaseTransactionProvider();

export function getBaseTransactionProvider(): BaseTransactionProvider {
  return instance;
}

/** Test-only: replaces the live Base RPC adapter. */
export function setBaseTransactionProvider(provider: BaseTransactionProvider): void {
  instance = provider;
}
