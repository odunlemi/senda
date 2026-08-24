import type { Generated, Selectable } from "kysely";

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
