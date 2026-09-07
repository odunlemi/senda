import type { Generated, Selectable } from "kysely";

import type { SendaAsset, SendaChain } from "../../src/config/payment.js";

export type PaymentIntentStatus =
  "created" | "awaiting_payment" | "confirming" | "paid" | "expired" | "failed" | "dropped";

export type PaymentReorgReason =
  | "missing_transaction_and_receipt"
  | "receipt_identity_changed"
  | "receipt_reverted"
  | "missing_transfer_log";

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
  submittedAt: Date | null;
  monitoringExpiresAt: Date | null;
  monitoringEscalatedAt: Date | null;
  paidAt: Date | null;
  reorgDetectedAt: Date | null;
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
