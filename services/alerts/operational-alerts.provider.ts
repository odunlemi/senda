import type { OperationalAlertPayload } from "../../contracts/operational-alerts.js";

export type OperationalAlertDeliveryResult =
  | { outcome: "accepted"; httpStatus: number }
  | {
      outcome: "retryable_failure" | "permanent_failure";
      errorCode: string;
      httpStatus: number | null;
    };

export interface OperationalAlertDeliveryAdapter {
  deliver(payload: OperationalAlertPayload): Promise<OperationalAlertDeliveryResult>;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function createWebhookOperationalAlertAdapter(config: {
  url: string;
  bearerToken: string;
  timeoutMs: number;
}): OperationalAlertDeliveryAdapter {
  return {
    async deliver(payload) {
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.bearerToken}`,
            "content-type": "application/json",
            "idempotency-key": payload.deliveryId,
            "x-senda-event": payload.eventKind,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: "manual",
        });

        if (response.ok) {
          return { outcome: "accepted", httpStatus: response.status };
        }

        const failure = {
          errorCode: `http_${response.status}`,
          httpStatus: response.status,
        };
        return isRetryableHttpStatus(response.status)
          ? { outcome: "retryable_failure", ...failure }
          : { outcome: "permanent_failure", ...failure };
      } catch (error) {
        const isTimeout =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return {
          outcome: "retryable_failure",
          errorCode: isTimeout ? "timeout" : "network_error",
          httpStatus: null,
        };
      }
    },
  };
}
