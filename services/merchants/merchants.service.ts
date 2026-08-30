import crypto from "node:crypto";

import { getDb } from "../../src/lib/db.js";

function canonicalizeEvmAddress(address: string): string {
  return address.toLowerCase();
}

export async function setMerchantWallet(
  merchantId: string,
  receivingWalletAddress: string,
): Promise<string> {
  const canonicalAddress = canonicalizeEvmAddress(receivingWalletAddress);

  await getDb()
    .transaction()
    .execute(async (trx) => {
      const merchant = await trx
        .selectFrom("user")
        .select(["id", "receivingWalletAddress"])
        .where("id", "=", merchantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (merchant.receivingWalletAddress === canonicalAddress) {
        return;
      }

      await trx
        .updateTable("user")
        .set({ receivingWalletAddress: canonicalAddress, updatedAt: new Date() })
        .where("id", "=", merchantId)
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("auditEvents")
        .values({
          id: crypto.randomUUID(),
          eventType: "merchant.receiving_wallet_changed",
          actorType: "merchant",
          actorId: merchantId,
          merchantId,
          paymentIntentId: null,
          metadata: {
            previousWalletAddress: merchant.receivingWalletAddress,
            newWalletAddress: canonicalAddress,
          },
        })
        .execute();
    });

  return canonicalAddress;
}
