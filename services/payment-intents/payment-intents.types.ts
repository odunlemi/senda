import type { Generated, Selectable } from "kysely";

import type { SendaAsset, SendaChain } from "../../src/config/payment.js";

export type PaymentIntentStatus =
  "created" | "awaiting_payment" | "confirming" | "paid" | "expired" | "failed";

export interface PaymentIntentsTable {
  id: string;
  merchantId: string;
  publicId: string;
  amountAtomic: string;
  asset: SendaAsset;
  chain: SendaChain;
  destinationAddress: string;
  description: string | null;
  reference: string | null;
  status: PaymentIntentStatus;
  expiresAt: Date;
  payerAddress: string | null;
  transactionHash: string | null;
  confirmationCount: number;
  providerEventId: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export type PaymentIntentRow = Selectable<PaymentIntentsTable>;

export interface CreatePaymentIntentInput {
  merchantId: string;
  amountAtomic: string;
  expiresAt: Date;
  description?: string;
  reference?: string;
}
