import crypto from "node:crypto";

import { env } from "../../src/config/env.js";
import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import { ConflictError, conflict, notFound } from "../../src/lib/errors.js";
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../../src/lib/db.js";
import { recordAuditEvent } from "../audit/audit-events.service.js";
import type { WalletChangeRequestRow } from "./merchants.types.js";

function canonicalizeEvmAddress(address: string): string {
  return address.toLowerCase();
}

function assertEvmAddress(address: string): string {
  const canonical = canonicalizeEvmAddress(address);
  if (!/^0x[a-f0-9]{40}$/.test(canonical)) {
    throw new Error("Invalid receiving wallet address");
  }
  return canonical;
}

async function acquireAddressLock(trx: Transaction<Database>, address: string): Promise<void> {
  // A transaction-scoped 64-bit advisory lock keyed by the canonical address
  // serializes setup, replacement request, and activation around one address.
  await sql`
    select pg_advisory_xact_lock(('x' || substr(md5(${address}), 1, 16))::bit(64)::bigint)
  `.execute(trx);
}

function addressEqualsColumn(column: string, address: string) {
  return sql<boolean>`lower(${sql.ref(column)}) = ${address}`;
}

async function assertAddressNotInUse(
  trx: Transaction<Database>,
  merchantId: string,
  address: string,
  excludeRequestId?: string,
): Promise<void> {
  const activeOther = await trx
    .selectFrom("user")
    .select("id")
    .where(addressEqualsColumn("receivingWalletAddress", address))
    .where("id", "!=", merchantId)
    .executeTakeFirst();
  if (activeOther) {
    conflict("Requested address is already in use by another merchant");
  }

  const query = trx
    .selectFrom("walletChangeRequests")
    .select("id")
    .where(addressEqualsColumn("requestedAddress", address))
    .where("status", "=", "pending")
    .where("merchantId", "!=", merchantId);

  const pendingOther = await (
    excludeRequestId ? query.where("id", "!=", excludeRequestId) : query
  ).executeTakeFirst();
  if (pendingOther) {
    conflict("Requested address is already pending for another merchant");
  }
}

export type SetOrRequestWalletResult =
  | { kind: "immediate"; address: string }
  | { kind: "pending"; request: WalletChangeRequestRow }
  | { kind: "no-op"; address: string };

export async function setOrRequestMerchantWallet(
  merchantId: string,
  receivingWalletAddress: string,
): Promise<SetOrRequestWalletResult> {
  const canonicalAddress = assertEvmAddress(receivingWalletAddress);

  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const merchant = await trx
        .selectFrom("user")
        .select(["id", "receivingWalletAddress"])
        .where("id", "=", merchantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      await acquireAddressLock(trx, canonicalAddress);

      if (merchant.receivingWalletAddress === canonicalAddress) {
        return { kind: "no-op", address: canonicalAddress };
      }

      await assertAddressNotInUse(trx, merchantId, canonicalAddress);

      const now = await getDatabaseTime(trx);

      if (merchant.receivingWalletAddress === null) {
        await trx
          .updateTable("user")
          .set({ receivingWalletAddress: canonicalAddress, updatedAt: now })
          .where("id", "=", merchantId)
          .executeTakeFirstOrThrow();

        await recordAuditEvent(trx, {
          eventType: "merchant.receiving_wallet_changed",
          actorType: "merchant",
          actorId: merchantId,
          merchantId,
          paymentIntentId: null,
          metadata: {
            previousWalletAddress: merchant.receivingWalletAddress,
            newWalletAddress: canonicalAddress,
          },
          createdAt: now,
        });

        return { kind: "immediate", address: canonicalAddress };
      }

      const existingPending = await trx
        .selectFrom("walletChangeRequests")
        .selectAll()
        .where("merchantId", "=", merchantId)
        .where("status", "=", "pending")
        .forUpdate()
        .executeTakeFirst();

      if (existingPending) {
        if (existingPending.requestedAddress === canonicalAddress) {
          return { kind: "pending", request: existingPending };
        }
        conflict("A pending wallet change already exists");
      }

      const activationAt = new Date(
        now.getTime() + env.MERCHANT_WALLET_CHANGE_DELAY_SECONDS * 1000,
      );

      const request = await trx
        .insertInto("walletChangeRequests")
        .values({
          id: crypto.randomUUID(),
          merchantId,
          previousAddress: merchant.receivingWalletAddress,
          requestedAddress: canonicalAddress,
          status: "pending",
          requestedAt: now,
          activationAt,
          cancelledAt: null,
          appliedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        eventType: "merchant.receiving_wallet_change_requested",
        actorType: "merchant",
        actorId: merchantId,
        merchantId,
        paymentIntentId: null,
        metadata: {
          previousWalletAddress: merchant.receivingWalletAddress,
          requestedWalletAddress: canonicalAddress,
          activationAt,
        },
        createdAt: now,
        operationalAlert: {
          eventKind: "merchant.receiving_wallet_change_requested",
          merchantId,
          walletChangeRequestId: request.id,
        },
      });

      return { kind: "pending", request };
    });
}

export async function getPendingWalletChange(
  merchantId: string,
): Promise<WalletChangeRequestRow | undefined> {
  return await getDb()
    .selectFrom("walletChangeRequests")
    .selectAll()
    .where("merchantId", "=", merchantId)
    .where("status", "=", "pending")
    .executeTakeFirst();
}

export async function cancelPendingWalletChange(
  merchantId: string,
): Promise<WalletChangeRequestRow> {
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      await trx
        .selectFrom("user")
        .select("id")
        .where("id", "=", merchantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const pending = await trx
        .selectFrom("walletChangeRequests")
        .select("id")
        .where("merchantId", "=", merchantId)
        .where("status", "=", "pending")
        .forUpdate()
        .executeTakeFirst();

      if (!pending) {
        notFound("No pending wallet change request");
      }

      const now = await getDatabaseTime(trx);
      const request = await trx
        .updateTable("walletChangeRequests")
        .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
        .where("id", "=", pending.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        eventType: "merchant.receiving_wallet_change_cancelled",
        actorType: "merchant",
        actorId: merchantId,
        merchantId,
        paymentIntentId: null,
        metadata: {
          previousWalletAddress: request.previousAddress,
          requestedWalletAddress: request.requestedAddress,
        },
        createdAt: now,
        operationalAlert: {
          eventKind: "merchant.receiving_wallet_change_cancelled",
          merchantId,
          walletChangeRequestId: request.id,
          cancelledBy: "merchant",
        },
      });

      return request;
    });
}

export type ApplyWalletChangeResult =
  | { kind: "applied"; request: WalletChangeRequestRow }
  | { kind: "not-due"; request: WalletChangeRequestRow }
  | { kind: "already-terminal"; request: WalletChangeRequestRow }
  | { kind: "cancelled"; request: WalletChangeRequestRow; reason: string };

export async function applyWalletChangeRequest(
  requestId: string,
): Promise<ApplyWalletChangeResult> {
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const loaded = await trx
        .selectFrom("walletChangeRequests")
        .selectAll()
        .where("id", "=", requestId)
        .executeTakeFirst();

      if (!loaded) {
        notFound("Wallet change request not found");
      }

      await trx
        .selectFrom("user")
        .select("id")
        .where("id", "=", loaded.merchantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      await acquireAddressLock(trx, loaded.requestedAddress);

      const request = await trx
        .selectFrom("walletChangeRequests")
        .selectAll()
        .where("id", "=", requestId)
        .where("status", "=", "pending")
        .forUpdate()
        .executeTakeFirst();

      if (!request) {
        const current = await trx
          .selectFrom("walletChangeRequests")
          .selectAll()
          .where("id", "=", requestId)
          .executeTakeFirstOrThrow();
        return { kind: "already-terminal", request: current };
      }

      const now = await getDatabaseTime(trx);
      if (request.activationAt.getTime() > now.getTime()) {
        return { kind: "not-due", request };
      }

      const merchant = await trx
        .selectFrom("user")
        .select(["id", "receivingWalletAddress"])
        .where("id", "=", request.merchantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (merchant.receivingWalletAddress !== request.previousAddress) {
        const cancelled = await trx
          .updateTable("walletChangeRequests")
          .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
          .where("id", "=", request.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();

        await recordAuditEvent(trx, {
          eventType: "merchant.receiving_wallet_change_cancelled",
          actorType: "system",
          actorId: null,
          merchantId: request.merchantId,
          paymentIntentId: null,
          metadata: {
            previousWalletAddress: request.previousAddress,
            requestedWalletAddress: request.requestedAddress,
            reason: "previous_address_changed_before_activation",
          },
          createdAt: now,
          operationalAlert: {
            eventKind: "merchant.receiving_wallet_change_cancelled",
            merchantId: request.merchantId,
            walletChangeRequestId: request.id,
            cancelledBy: "system",
            reason: "previous_address_changed_before_activation",
          },
        });

        return {
          kind: "cancelled",
          request: cancelled,
          reason: "previous_address_changed_before_activation",
        };
      }

      try {
        await assertAddressNotInUse(trx, request.merchantId, request.requestedAddress, request.id);
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          throw error;
        }

        const cancelled = await trx
          .updateTable("walletChangeRequests")
          .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
          .where("id", "=", request.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();

        await recordAuditEvent(trx, {
          eventType: "merchant.receiving_wallet_change_cancelled",
          actorType: "system",
          actorId: null,
          merchantId: request.merchantId,
          paymentIntentId: null,
          metadata: {
            previousWalletAddress: request.previousAddress,
            requestedWalletAddress: request.requestedAddress,
            reason: "requested_address_unavailable_before_activation",
          },
          createdAt: now,
          operationalAlert: {
            eventKind: "merchant.receiving_wallet_change_cancelled",
            merchantId: request.merchantId,
            walletChangeRequestId: request.id,
            cancelledBy: "system",
            reason: "requested_address_unavailable_before_activation",
          },
        });

        return {
          kind: "cancelled",
          request: cancelled,
          reason: "requested_address_unavailable_before_activation",
        };
      }

      await trx
        .updateTable("user")
        .set({ receivingWalletAddress: request.requestedAddress, updatedAt: now })
        .where("id", "=", request.merchantId)
        .executeTakeFirstOrThrow();

      const applied = await trx
        .updateTable("walletChangeRequests")
        .set({ status: "applied", appliedAt: now, updatedAt: now })
        .where("id", "=", request.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordAuditEvent(trx, {
        eventType: "merchant.receiving_wallet_change_applied",
        actorType: "system",
        actorId: null,
        merchantId: request.merchantId,
        paymentIntentId: null,
        metadata: {
          previousWalletAddress: request.previousAddress,
          newWalletAddress: request.requestedAddress,
          activationAt: request.activationAt,
        },
        createdAt: now,
        operationalAlert: {
          eventKind: "merchant.receiving_wallet_change_applied",
          merchantId: request.merchantId,
          walletChangeRequestId: request.id,
        },
      });

      await recordAuditEvent(trx, {
        eventType: "merchant.receiving_wallet_changed",
        actorType: "system",
        actorId: null,
        merchantId: request.merchantId,
        paymentIntentId: null,
        metadata: {
          previousWalletAddress: request.previousAddress,
          newWalletAddress: request.requestedAddress,
        },
        createdAt: now,
      });

      return { kind: "applied", request: applied };
    });
}
