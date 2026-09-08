import { z } from "zod";

const alertEnvelopeSchema = z.object({
  version: z.literal(1),
  deliveryId: z.uuid(),
  eventTime: z.iso.datetime(),
});

const walletChangeSubjectSchema = z
  .object({
    merchantId: z.string().min(1),
    walletChangeRequestId: z.uuid(),
  })
  .strict();

const systemCancellationReasonSchema = z.enum([
  "previous_address_changed_before_activation",
  "requested_address_unavailable_before_activation",
]);

export const operationalAlertPayloadSchema = z.discriminatedUnion("eventKind", [
  alertEnvelopeSchema
    .extend({
      eventKind: z.literal("merchant.receiving_wallet_change_requested"),
      subject: walletChangeSubjectSchema,
    })
    .strict(),
  alertEnvelopeSchema
    .extend({
      eventKind: z.literal("merchant.receiving_wallet_change_cancelled"),
      subject: z.discriminatedUnion("cancelledBy", [
        walletChangeSubjectSchema.extend({ cancelledBy: z.literal("merchant") }).strict(),
        walletChangeSubjectSchema
          .extend({
            cancelledBy: z.literal("system"),
            reason: systemCancellationReasonSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  alertEnvelopeSchema
    .extend({
      eventKind: z.literal("merchant.receiving_wallet_change_applied"),
      subject: walletChangeSubjectSchema,
    })
    .strict(),
  alertEnvelopeSchema
    .extend({
      eventKind: z.literal("payment.reorg_detected"),
      subject: z
        .object({
          merchantId: z.string().min(1),
          paymentIntentId: z.uuid(),
          paymentPublicId: z.uuid(),
          reason: z.enum([
            "missing_transaction_and_receipt",
            "receipt_identity_changed",
            "receipt_reverted",
            "missing_transfer_log",
          ]),
        })
        .strict(),
    })
    .strict(),
]);

export type OperationalAlertPayload = z.infer<typeof operationalAlertPayloadSchema>;
export type OperationalAlertEventKind = OperationalAlertPayload["eventKind"];
