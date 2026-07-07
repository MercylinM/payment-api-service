import client from "prom-client";

client.collectDefaultMetrics();

export const paymentsCreatedTotal = new client.Counter({
  name: "payments_created_total",
  help: "Total payments created",
});

export const paymentsSuccessTotal = new client.Counter({
  name: "payments_success_total",
  help: "Total payments succeeded",
});

export const paymentsFailedTotal = new client.Counter({
  name: "payments_failed_total",
  help: "Total payments failed",
});

export const providerRequestsTotal = new client.Counter({
  name: "provider_requests_total",
  help: "Total provider requests made",
});

export const providerTimeoutsTotal = new client.Counter({
  name: "provider_timeouts_total",
  help: "Total provider timeouts",
});

export const idempotencyReplaysTotal = new client.Counter({
  name: "idempotency_replays_total",
  help: "Total idempotent replays returned",
});

export const idempotencyConflictsTotal = new client.Counter({
  name: "idempotency_conflicts_total",
  help: "Total idempotency key conflicts",
});

export const paymentProcessingDuration = new client.Histogram({
  name: "payment_processing_duration_seconds",
  help: "Duration of payment processing",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

export const registry = client.register;
