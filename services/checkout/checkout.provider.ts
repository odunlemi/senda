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
  getTransactionReceipt(transactionHash: string): Promise<BaseTransactionReceipt | undefined>;
  getCurrentBlockNumber(): Promise<number>;
}

export interface BaseTransactionReceipt {
  transactionHash: string;
  blockNumber: string | null;
  status: string | null;
}

class JsonRpcBaseTransactionProvider implements BaseTransactionProvider {
  private async rpc<T>(method: string, params: string[]): Promise<T | undefined> {
    const response = await fetch(env.BASE_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`Base RPC request failed with status ${response.status}`);
    const body = (await response.json()) as {
      result?: T | null;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "Base RPC request failed");
    return body.result ?? undefined;
  }

  async getTransaction(transactionHash: string): Promise<BaseTransaction | undefined> {
    return this.rpc<BaseTransaction>("eth_getTransactionByHash", [transactionHash]);
  }

  async getTransactionReceipt(
    transactionHash: string,
  ): Promise<BaseTransactionReceipt | undefined> {
    return this.rpc<BaseTransactionReceipt>("eth_getTransactionReceipt", [transactionHash]);
  }

  async getCurrentBlockNumber(): Promise<number> {
    const blockNumber = await this.rpc<string>("eth_blockNumber", []);
    if (!blockNumber) throw new Error("Base RPC returned no block number");
    return Number.parseInt(blockNumber, 16);
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
