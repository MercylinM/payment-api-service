# Technical Note

## How idempotency is implemented

Each payment request is scoped by `(organisation_id, idempotency_key)`. A `UNIQUE` constraint on those two columns in the `payments` table is the primary guard — no application-level check alone can prevent duplicates under concurrency.

Before inserting, the service computes a deterministic SHA-256 hash of the semantically significant request fields (amount, currency, recipient, etc.). On a repeated request the hash is compared to the stored one:

- Same hash → return the existing payment (replay).
- Different hash → reject with `409 Conflict`.

## How concurrent requests are handled

Two requests with the same `(organisation_id, idempotency_key)` arriving simultaneously are handled by:

1. A PostgreSQL advisory transaction lock keyed on an MD5 of `org:idempotency_key`. This serialises the read-then-insert within a `SERIALIZABLE` transaction.
2. The `UNIQUE` constraint as a hard backstop — even if two transactions somehow bypass the advisory lock, only one `INSERT` will succeed; the other receives a unique-violation error which the service handles by re-reading and returning the existing payment.

This works correctly across multiple application replicas because the lock and constraint live in the database.

## How request equality is determined

A canonical JSON string is built from the fields that define payment identity:

```
{ organisationId, customerReference, amount, currency, recipientType, recipientValue }
```

This string is SHA-256 hashed and stored as `request_hash`. `description` is intentionally excluded — it is metadata, not payment identity.

## Request Hash Determinism

The canonical JSON is built with a fixed key order:
`organisationId`, `customerReference`, `amount`, `currency`, `recipientType`, `recipientValue`

This ensures the same logical request always produces the same hash, even if the HTTP request body has different key ordering. The `JSON.stringify()` function in Node.js maintains insertion order for object keys (since ES2015), making the hash deterministic across all Node.js versions and multiple instances.

The amount is stored as-is (numeric) before hashing, ensuring that `1500.00` and `1500` (different JSON representations of the same value) produce the same hash.

## How provider timeouts are handled

When the provider call times out, the outcome is unknown — the provider may or may not have processed the payment. The service:

1. Records a `TIMEOUT` attempt in `payment_attempts` with the `provider_request_id` used.
2. Leaves the payment in `PROCESSING` status (does **not** mark it `FAILED`).
3. Does not retry automatically — a human or reconciliation job must decide.

This is the cautious choice: marking it `FAILED` and retrying risks a double debit; marking it `SUCCESS` without confirmation is incorrect.

## How duplicate provider payments are prevented

Each provider call uses a stable `providerRequestId` (a UUID stored in `payment_attempts`). The mock provider implements its own idempotency on `requestId`. In the `success_then_timeout` scenario:

- The client retries the *payment API* request with the same idempotency key.
- The idempotency layer returns the existing payment record immediately — no new provider call is made.
- The existing `providerRequestId` in `payment_attempts` can be used for reconciliation.

## Transaction boundaries

| Operation | Transaction scope |
|-----------|------------------|
| Idempotency check + INSERT | Single `SERIALIZABLE` transaction with advisory lock |
| Status transition | Single `UPDATE ... WHERE status = ANY(...)` — atomic |
| Attempt recording | Outside the main transaction (append-only audit log) |

Provider calls are made outside any database transaction to avoid holding locks during network I/O.

## Important trade-offs

- **Synchronous HTTP response, async processing**: The API returns `201` as soon as the payment row is persisted. Provider processing happens asynchronously. This keeps response times low but means the client must poll for the final status.
- **Advisory locks vs. optimistic locking**: Advisory locks are simpler but hold a connection. Optimistic locking (compare-and-swap on a version column) would scale better under high contention.
- **No automatic retry on timeout**: Safer for correctness but requires operational tooling to resolve stuck `PROCESSING` payments.

## Known limitations

- No authentication or authorisation.
- No automatic retry / reconciliation for timed-out payments.
- `PROCESSING` payments are not cleaned up if the app crashes mid-flight.
- Single provider; no circuit breaker or fallback.

## What I would improve for production

- **Reconciliation job**: Add a background reconciliation job that queries the provider for `PROCESSING` payments older than N minutes using the stored `providerRequestId`. This resolves uncertain outcomes and moves payments to their final state.

- **Circuit breaker**: Implement a circuit breaker (e.g. `opossum`) around the provider client to fail fast and prevent cascading failures when the provider is degraded.

- **Idempotency key expiry**: Reject keys older than 24 hours to prevent old keys from being accidentally replayed. This also allows cleanup of old payment records.

- **Lock-free idempotency**: Replace advisory locks with `INSERT ... ON CONFLICT DO NOTHING` + a subsequent `SELECT` for a lock-free approach. This scales better under high concurrency without holding database connections.

- **Distributed tracing**: Add OpenTelemetry tracing to correlate requests across provider calls and downstream services. Include trace IDs in structured logs.

- **Async queue**: Move payment processing to a durable queue (SQS/RabbitMQ) for at-least-once delivery guarantees and decoupling from the HTTP request lifecycle.

- **Webhook callbacks**: Implement a callback endpoint (`POST /provider/callbacks`) so the provider can notify of asynchronous payment results, reducing polling overhead.

- **Retry scheduling**: Implement exponential backoff for retrying `PROCESSING` payments, with max retry limits and dead-letter handling.

- **Authentication & authorization**: Add OAuth2 or API key authentication. Include organization isolation checks to prevent cross-tenant access.

- **Rate limiting**: Implement per-organization rate limits to prevent abuse and resource exhaustion.

- **Payment status history**: Track status transitions with timestamps for audit and debugging. Include reason/context for each transition.

- **Encryption**: Encrypt sensitive fields (phone numbers, provider references) at rest using a KMS key.

- **Idempotency across organizations**: Consider extending idempotency to support the same `idempotency_key + customer_reference` pair across organizations, with explicit organization scoping in the request.

