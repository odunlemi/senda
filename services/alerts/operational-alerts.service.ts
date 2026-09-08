import { randomUUID } from "node:crypto";

import type { Transaction } from "kysely";

import {
  operationalAlertPayloadSchema,
  type OperationalAlertPayload,
} from "../../contracts/operational-alerts.js";
import type { Database } from "../../src/lib/db.js";

export type OperationalAlertInput =
  | {
      eventKind: "merchant.receiving_wallet_change_requested";
      merchantId: string;
      walletChangeRequestId: string;
    }
  | {
      eventKind: "merchant.receiving_wallet_change_cancelled";
      merchantId: string;
      walletChangeRequestId: string;
      cancelledBy: "merchant";
    }
  | {
      eventKind: "merchant.receiving_wallet_change_cancelled";
      merchantId: string;
      walletChangeRequestId: string;
      cancelledBy: "system";
      reason:
        | "previous_address_changed_before_activation"
        | "requested_address_unavailable_before_activation";
    }
  | {
      eventKind: "merchant.receiving_wallet_change_applied";
      merchantId: string;
      walletChangeRequestId: string;
    }
  | {
      eventKind: "payment.reorg_detected";
      merchantId: string;
      paymentIntentId: string;
      paymentPublicId: string;
      reason:
        | "missing_transaction_and_receipt"
        | "receipt_identity_changed"
        | "receipt_reverted"
        | "missing_transfer_log";
    };

function buildPayload(
  deliveryId: string,
  eventTime: Date,
  input: OperationalAlertInput,
): OperationalAlertPayload {
  const envelope = {
    version: 1 as const,
    deliveryId,
    eventTime: eventTime.toISOString(),
  };

  switch (input.eventKind) {
    case "merchant.receiving_wallet_change_requested":
      return {
        ...envelope,
        eventKind: input.eventKind,
        subject: {
          merchantId: input.merchantId,
          walletChangeRequestId: input.walletChangeRequestId,
        },
      };
    case "merchant.receiving_wallet_change_cancelled":
      if (input.cancelledBy === "merchant") {
        return {
          ...envelope,
          eventKind: input.eventKind,
          subject: {
            merchantId: input.merchantId,
            walletChangeRequestId: input.walletChangeRequestId,
            cancelledBy: input.cancelledBy,
          },
        };
      }
      return {
        ...envelope,
        eventKind: input.eventKind,
        subject: {
          merchantId: input.merchantId,
          walletChangeRequestId: input.walletChangeRequestId,
          cancelledBy: input.cancelledBy,
          reason: input.reason,
        },
      };
    case "merchant.receiving_wallet_change_applied":
      return {
        ...envelope,
        eventKind: input.eventKind,
        subject: {
          merchantId: input.merchantId,
          walletChangeRequestId: input.walletChangeRequestId,
        },
      };
    case "payment.reorg_detected":
      return {
        ...envelope,
        eventKind: input.eventKind,
        subject: {
          merchantId: input.merchantId,
          paymentIntentId: input.paymentIntentId,
          paymentPublicId: input.paymentPublicId,
          reason: input.reason,
        },
      };
  }
}

export async function enqueueOperationalAlert(
  trx: Transaction<Database>,
  input: {
    auditEventId: string;
    eventTime: Date;
    alert: OperationalAlertInput;
  },
): Promise<string> {
  const deliveryId = randomUUID();
  const payload = operationalAlertPayloadSchema.parse(
    buildPayload(deliveryId, input.eventTime, input.alert),
  );

  await trx
    .insertInto("operationalAlertDeliveries")
    .values({
      id: deliveryId,
      auditEventId: input.auditEventId,
      eventKind: payload.eventKind,
      payloadVersion: payload.version,
      payload,
      occurredAt: input.eventTime,
      status: "pending",
      nextAttemptAt: input.eventTime,
      leaseToken: null,
      leasedUntil: null,
      lastAttemptAt: null,
      deliveredAt: null,
      failedAt: null,
      lastErrorCode: null,
      lastHttpStatus: null,
      updatedAt: input.eventTime,
    })
    .execute();

  return deliveryId;
}
