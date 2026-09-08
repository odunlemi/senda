import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { operationalAlertPayloadSchema } from "../../contracts/operational-alerts.js";
import { env } from "../../src/config/env.js";
import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import type {
  OperationalAlertDeliveryAdapter,
  OperationalAlertDeliveryResult,
} from "./operational-alerts.provider.js";
import { createWebhookOperationalAlertAdapter } from "./operational-alerts.provider.js";
import type { OperationalAlertDeliveryRow } from "./operational-alerts.types.js";

interface ClaimedOperationalAlert extends OperationalAlertDeliveryRow {
  leaseToken: string;
  leasedUntil: Date;
  lastAttemptAt: Date;
}

interface OperationalAlertClaimResult {
  deliveries: ClaimedOperationalAlert[];
  exhausted: number;
}

export interface OperationalAlertDispatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  exhausted: number;
  staleResults: number;
}

function emptySummary(): OperationalAlertDispatchSummary {
  return {
    claimed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    exhausted: 0,
    staleResults: 0,
  };
}

export async function claimOperationalAlerts(config: {
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
}): Promise<OperationalAlertClaimResult> {
  const leaseToken = randomUUID();

  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const exhausted = await sql<{ id: string }>`
        with ineligible as (
          select "id"
          from "operationalAlertDeliveries"
          where "attemptCount" >= ${config.maxAttempts}
            and (
              "status" = 'pending'
              or (
                "status" = 'processing'
                and "leasedUntil" <= clock_timestamp()
              )
            )
          order by coalesce("nextAttemptAt", "leasedUntil"), "id"
          for update skip locked
          limit ${config.batchSize}
        )
        update "operationalAlertDeliveries" as delivery
        set "status" = 'exhausted',
            "nextAttemptAt" = null,
            "leaseToken" = null,
            "leasedUntil" = null,
            "failedAt" = clock_timestamp(),
            "lastErrorCode" = case
              when delivery."status" = 'processing'
                then 'lease_expired_after_max_attempts'
              else 'attempt_limit_reached'
            end,
            "updatedAt" = clock_timestamp()
        from ineligible
        where delivery."id" = ineligible."id"
        returning delivery."id"
      `.execute(trx);

      const claimed = await sql<ClaimedOperationalAlert>`
        with candidates as (
          select "id"
          from "operationalAlertDeliveries"
          where "attemptCount" < ${config.maxAttempts}
            and (
              (
                "status" = 'pending'
                and "nextAttemptAt" <= clock_timestamp()
              ) or (
                "status" = 'processing'
                and "leasedUntil" <= clock_timestamp()
              )
            )
          order by coalesce("nextAttemptAt", "leasedUntil"), "id"
          for update skip locked
          limit ${config.batchSize}
        )
        update "operationalAlertDeliveries" as delivery
        set "status" = 'processing',
            "attemptCount" = delivery."attemptCount" + 1,
            "nextAttemptAt" = null,
            "leaseToken" = ${leaseToken},
            "leasedUntil" = clock_timestamp()
              + ${config.leaseMs} * interval '1 millisecond',
            "lastAttemptAt" = clock_timestamp(),
            "updatedAt" = clock_timestamp()
        from candidates
        where delivery."id" = candidates."id"
        returning delivery.*
      `.execute(trx);

      return {
        deliveries: claimed.rows,
        exhausted: exhausted.rows.length,
      };
    });
}

export async function replayOperationalAlert(deliveryId: string): Promise<boolean> {
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const now = await getDatabaseTime(trx);
      const replayed = await trx
        .updateTable("operationalAlertDeliveries")
        .set({
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: now,
          leaseToken: null,
          leasedUntil: null,
          lastAttemptAt: null,
          deliveredAt: null,
          failedAt: null,
          lastErrorCode: null,
          lastHttpStatus: null,
          updatedAt: now,
        })
        .where("id", "=", deliveryId)
        .where("status", "in", ["failed", "exhausted"])
        .returning("id")
        .executeTakeFirst();

      return replayed !== undefined;
    });
}

async function recordAccepted(
  delivery: ClaimedOperationalAlert,
  httpStatus: number,
): Promise<boolean> {
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const now = await getDatabaseTime(trx);
      const updated = await trx
        .updateTable("operationalAlertDeliveries")
        .set({
          status: "delivered",
          nextAttemptAt: null,
          leaseToken: null,
          leasedUntil: null,
          deliveredAt: now,
          failedAt: null,
          lastErrorCode: null,
          lastHttpStatus: httpStatus,
          updatedAt: now,
        })
        .where("id", "=", delivery.id)
        .where("status", "=", "processing")
        .where("leaseToken", "=", delivery.leaseToken)
        .returning("id")
        .executeTakeFirst();
      return updated !== undefined;
    });
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  return Math.min(
    env.OPERATIONAL_ALERT_RETRY_BASE_MS * 2 ** exponent,
    env.OPERATIONAL_ALERT_RETRY_MAX_MS,
  );
}

async function recordFailure(
  delivery: ClaimedOperationalAlert,
  result: Exclude<OperationalAlertDeliveryResult, { outcome: "accepted" }>,
): Promise<"retried" | "failed" | "exhausted" | "stale"> {
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      const now = await getDatabaseTime(trx);
      const shouldRetry =
        result.outcome === "retryable_failure" &&
        delivery.attemptCount < env.OPERATIONAL_ALERT_MAX_ATTEMPTS;
      const terminalStatus = result.outcome === "permanent_failure" ? "failed" : "exhausted";
      const status = shouldRetry ? "pending" : terminalStatus;
      const updated = await trx
        .updateTable("operationalAlertDeliveries")
        .set({
          status,
          nextAttemptAt: shouldRetry
            ? new Date(now.getTime() + retryDelayMs(delivery.attemptCount))
            : null,
          leaseToken: null,
          leasedUntil: null,
          deliveredAt: null,
          failedAt: shouldRetry ? null : now,
          lastErrorCode: result.errorCode,
          lastHttpStatus: result.httpStatus,
          updatedAt: now,
        })
        .where("id", "=", delivery.id)
        .where("status", "=", "processing")
        .where("leaseToken", "=", delivery.leaseToken)
        .returning("id")
        .executeTakeFirst();

      if (!updated) return "stale";
      if (shouldRetry) return "retried";
      return terminalStatus;
    });
}

async function deliverClaim(
  delivery: ClaimedOperationalAlert,
  adapter: OperationalAlertDeliveryAdapter,
  summary: OperationalAlertDispatchSummary,
): Promise<void> {
  const parsed = operationalAlertPayloadSchema.safeParse(delivery.payload);
  const result: OperationalAlertDeliveryResult = parsed.success
    ? await adapter.deliver(parsed.data).catch(() => ({
        outcome: "retryable_failure" as const,
        errorCode: "adapter_error",
        httpStatus: null,
      }))
    : {
        outcome: "permanent_failure",
        errorCode: "invalid_payload",
        httpStatus: null,
      };

  if (result.outcome === "accepted") {
    if (await recordAccepted(delivery, result.httpStatus)) {
      summary.delivered += 1;
      logger.info(
        { deliveryId: delivery.id, eventKind: delivery.eventKind },
        "operational alert delivered",
      );
    } else {
      summary.staleResults += 1;
      logger.warn({ deliveryId: delivery.id }, "stale operational alert result ignored");
    }
    return;
  }

  const outcome = await recordFailure(delivery, result);
  if (outcome === "stale") {
    summary.staleResults += 1;
    logger.warn({ deliveryId: delivery.id }, "stale operational alert failure ignored");
    return;
  }

  summary[outcome] += 1;
  logger.warn(
    {
      deliveryId: delivery.id,
      eventKind: delivery.eventKind,
      attemptCount: delivery.attemptCount,
      outcome,
      errorCode: result.errorCode,
      httpStatus: result.httpStatus,
    },
    "operational alert delivery failed",
  );
}

export async function dispatchOperationalAlerts(
  adapter: OperationalAlertDeliveryAdapter,
): Promise<OperationalAlertDispatchSummary> {
  const claimResult = await claimOperationalAlerts({
    batchSize: env.OPERATIONAL_ALERT_BATCH_SIZE,
    leaseMs: env.OPERATIONAL_ALERT_LEASE_MS,
    maxAttempts: env.OPERATIONAL_ALERT_MAX_ATTEMPTS,
  });
  const summary = emptySummary();
  summary.claimed = claimResult.deliveries.length;
  summary.exhausted = claimResult.exhausted;

  await Promise.all(
    claimResult.deliveries.map(async (delivery) => deliverClaim(delivery, adapter, summary)),
  );
  return summary;
}

function configuredAdapter(): OperationalAlertDeliveryAdapter | null {
  if (env.OPERATIONAL_ALERTS_MODE === "disabled") return null;
  if (!env.OPERATIONAL_ALERT_WEBHOOK_URL || !env.OPERATIONAL_ALERT_WEBHOOK_TOKEN) {
    throw new Error("Operational alert webhook configuration is incomplete");
  }
  return createWebhookOperationalAlertAdapter({
    url: env.OPERATIONAL_ALERT_WEBHOOK_URL,
    bearerToken: env.OPERATIONAL_ALERT_WEBHOOK_TOKEN,
    timeoutMs: env.OPERATIONAL_ALERT_TIMEOUT_MS,
  });
}

export function startOperationalAlertWorker(): () => void {
  const adapter = configuredAdapter();
  if (!adapter) {
    logger.warn({ mode: "disabled" }, "operational alert delivery is disabled");
    return () => undefined;
  }

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await dispatchOperationalAlerts(adapter);
      logger.info(summary, "operational alert worker cycle completed");
    } catch (error) {
      logger.error({ err: error }, "operational alert worker cycle failed");
    } finally {
      running = false;
    }
  };

  logger.info({ mode: "webhook" }, "operational alert worker started");
  const timer = setInterval(() => {
    void run();
  }, env.OPERATIONAL_ALERT_DISPATCH_INTERVAL_MS);
  timer.unref();
  void run();

  return () => {
    clearInterval(timer);
    logger.info("operational alert worker stopped");
  };
}
