import { env } from "../../src/config/env.js";
import { paymentConfig } from "../../src/config/payment.js";

export interface BaseTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
}

export interface BaseTransactionLog {
  address: string;
  topics: string[];
  data: string;
  removed?: boolean;
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
  logs: BaseTransactionLog[];
}

export class JsonRpcBaseTransactionProvider implements BaseTransactionProvider {
  private chainIdentityValidated = false;

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

  private async ensureBaseChain(): Promise<void> {
    if (this.chainIdentityValidated) return;
    const chainId = await this.rpc<string>("eth_chainId", []);
    if (!chainId || Number.parseInt(chainId, 16) !== paymentConfig.chainId) {
      throw new Error(`Base RPC chain mismatch; expected chain ${paymentConfig.chainId}`);
    }
    this.chainIdentityValidated = true;
  }

  async getTransaction(transactionHash: string): Promise<BaseTransaction | undefined> {
    await this.ensureBaseChain();
    return this.rpc<BaseTransaction>("eth_getTransactionByHash", [transactionHash]);
  }

  async getTransactionReceipt(
    transactionHash: string,
  ): Promise<BaseTransactionReceipt | undefined> {
    await this.ensureBaseChain();
    return this.rpc<BaseTransactionReceipt>("eth_getTransactionReceipt", [transactionHash]);
  }

  async getCurrentBlockNumber(): Promise<number> {
    await this.ensureBaseChain();
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
