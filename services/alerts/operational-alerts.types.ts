import type { Generated, Selectable } from "kysely";

import type {
  OperationalAlertEventKind,
  OperationalAlertPayload,
} from "../../contracts/operational-alerts.js";

export type OperationalAlertDeliveryStatus =
  "pending" | "processing" | "delivered" | "failed" | "exhausted";

export interface OperationalAlertDeliveriesTable {
  id: string;
  auditEventId: string;
  eventKind: OperationalAlertEventKind;
  payloadVersion: 1;
  payload: OperationalAlertPayload;
  occurredAt: Date;
  status: OperationalAlertDeliveryStatus;
  attemptCount: Generated<number>;
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  lastErrorCode: string | null;
  lastHttpStatus: number | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export type OperationalAlertDeliveryRow = Selectable<OperationalAlertDeliveriesTable>;
