import crypto from "node:crypto";

import type { Transaction } from "kysely";

import type { Database } from "../../src/lib/db.js";
import {
  enqueueOperationalAlert,
  type OperationalAlertInput,
} from "../alerts/operational-alerts.service.js";
import type { AuditActorType, AuditEventType } from "./audit-events.types.js";

export async function recordAuditEvent(
  trx: Transaction<Database>,
  values: {
    eventType: AuditEventType;
    actorType: AuditActorType;
    actorId: string | null;
    merchantId: string;
    paymentIntentId: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
    operationalAlert?: OperationalAlertInput;
  },
): Promise<string> {
  const auditEventId = crypto.randomUUID();

  await trx
    .insertInto("auditEvents")
    .values({
      id: auditEventId,
      eventType: values.eventType,
      actorType: values.actorType,
      actorId: values.actorId,
      merchantId: values.merchantId,
      paymentIntentId: values.paymentIntentId,
      metadata: values.metadata,
      createdAt: values.createdAt,
    })
    .execute();

  if (values.operationalAlert) {
    if (values.operationalAlert.eventKind !== values.eventType) {
      throw new Error("Operational alert kind must match its audit event");
    }
    await enqueueOperationalAlert(trx, {
      auditEventId,
      eventTime: values.createdAt,
      alert: values.operationalAlert,
    });
  }

  return auditEventId;
}
