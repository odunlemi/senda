import type { Generated, Selectable } from "kysely";

export type WalletChangeRequestStatus = "pending" | "cancelled" | "applied";

export interface MerchantsTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  receivingWalletAddress: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export type MerchantRow = Selectable<MerchantsTable>;

export interface WalletChangeRequestsTable {
  id: string;
  merchantId: string;
  previousAddress: string;
  requestedAddress: string;
  status: WalletChangeRequestStatus;
  requestedAt: Generated<Date>;
  activationAt: Date;
  cancelledAt: Date | null;
  appliedAt: Date | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export type WalletChangeRequestRow = Selectable<WalletChangeRequestsTable>;
