import type { Generated, Selectable } from "kysely";

export type AuditEventType = "merchant.receiving_wallet_changed" | "payment.reorg_detected";

export type AuditActorType = "merchant" | "system";

export interface AuditEventsTable {
  id: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorId: string | null;
  merchantId: string | null;
  paymentIntentId: string | null;
  metadata: unknown;
  createdAt: Generated<Date>;
}

export type AuditEventRow = Selectable<AuditEventsTable>;
