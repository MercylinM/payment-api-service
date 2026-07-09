# Payment API Service

A payment processing API built with Node.js, TypeScript, and PostgreSQL. Designed to handle financial transactions with idempotency guarantees, concurrency safety, and status tracking.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Local Development](#local-development)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Documentation](#documentation)

---

## Overview

The service solves three core problems in payment processing:

1. **Duplicate charges** — Network timeouts cause clients to retry. Without idempotency, the same payment could be charged twice.
2. **Race conditions** — Concurrent requests with the same idempotency key must produce exactly one payment, even across multiple service replicas.
3. **Uncertain provider outcomes** — A provider may process a payment but fail to return a response. The service preserves enough information to reconcile without re-charging.

### How it works

Payment creation writes a payment row and an outbox record atomically in a single SERIALIZABLE transaction. A background worker picks up the outbox record, calls the provider, and transitions the payment to its final status. The `providerRequestId` is fixed at creation time and reused on every retry, so the provider can deduplicate even if the first attempt succeeded silently.

```
POST /api/v1/payments
        |
        v
Validation + idempotency check
(advisory lock + SERIALIZABLE transaction)
        |
        v
INSERT payment (PENDING) + INSERT outbox record
[same atomic transaction]
        |
        v
Return 201 Created
        |
        v
Outbox worker (background)
        |
        ├── provider call succeeds  --> payment = SUCCESS
        ├── provider rejects        --> payment = FAILED
        ├── provider times out      --> payment stays PROCESSING
                                        (retry with same providerRequestId)
```

---

## Quick Start

```bash
# Start PostgreSQL, mock provider, and API
docker compose up --build

# Verify
curl http://localhost:3000/health

# Create a payment
curl -X POST http://localhost:3000/api/v1/payments \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "organisationId": "8b24a9b4-58f5-42f1-a6ef-697cfb321164",
    "customerReference": "INV-2026-001",
    "amount": 1500.00,
    "currency": "KES",
    "recipient": {
      "type": "MOBILE_MONEY",
      "phoneNumber": "+254712345678"
    },
    "description": "Supplier payment"
  }'

# Get payment status
curl http://localhost:3000/api/v1/payments/<paymentId>
```

| Service | URL | Purpose |
|---------|-----|---------|
| API | http://localhost:3000 | Payment API |
| Mock provider | http://localhost:4000 | Simulated payment provider |
| Worker | http://localhost:9100 | Polls `payment_outbox` and drives payments to SUCCESS/FAILED |
| Worker metrics | http://localhost:9100/metrics | Prometheus metrics for provider requests/timeouts/success/failure (separate process from the API, so not on port 3000) |
| API docs | http://localhost:3000/docs | Swagger UI |
| Health | http://localhost:3000/health | Health check |
| Metrics | http://localhost:3000/metrics | Prometheus metrics |

`docker compose up --build` starts all four containers (`postgres`, `mock-provider`, `app`, `worker`). The `worker` service runs the same image as `app` with its command overridden to `node dist/worker/processor.js`, and waits for `app`'s healthcheck (which only passes after migrations have run) before starting. Without the worker running, payments will remain in `PENDING` forever.

---

## Local Development

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Docker and Docker Compose (for running PostgreSQL and the full stack)
- npm 8+

### Setup

```bash
# Install dependencies
npm install

# Start PostgreSQL
docker run -d \
  --name payments-db \
  -e POSTGRES_USER=payments \
  -e POSTGRES_PASSWORD=payments \
  -e POSTGRES_DB=payments \
  -p 5432:5432 \
  postgres:16-alpine

# Set environment variables
export DATABASE_URL=postgres://payments:payments@localhost:5432/payments
export PROVIDER_URL=http://localhost:4000
export PROVIDER_TIMEOUT_MS=5000

# Run migrations
npm run migrate

# Terminal 1: mock provider
PROVIDER_MODE=success npx ts-node src/provider/server.ts

# Terminal 2: API
npm run dev

# Terminal 3: outbox worker
npm run worker
```

### Commands

```bash
npm run build     # Compile TypeScript to dist/
npm run dev       # Start with ts-node (hot reload)
npm run worker    # Start the outbox worker
npm run migrate   # Run database migrations
npm test          # Run test suite
```

### Mock provider modes

Set `PROVIDER_MODE` on the mock provider process:

| Mode | Behaviour |
|------|-----------|
| `success` | Returns SUCCESS |
| `reject` | Returns 422 business rejection |
| `timeout` | Never responds (triggers client timeout) |
| `success_then_timeout` | Processes payment but drops the response |
| `error500` | Returns HTTP 500 |

---

## API Reference

### Create payment

```
POST /api/v1/payments
Idempotency-Key: <uuid>
Content-Type: application/json
```

Request body:

```json
{
  "organisationId": "8b24a9b4-58f5-42f1-a6ef-697cfb321164",
  "customerReference": "INV-2026-001",
  "amount": 1500.00,
  "currency": "KES",
  "recipient": {
    "type": "MOBILE_MONEY",
    "phoneNumber": "+254712345678"
  },
  "description": "Supplier payment"
}
```

Response `201 Created`:

```json
{
  "paymentId": "7529bd27-a9f9-4bf0-a6b5-f9e120fda8ca",
  "organisationId": "8b24a9b4-58f5-42f1-a6ef-697cfb321164",
  "customerReference": "INV-2026-001",
  "amount": 1500.00,
  "currency": "KES",
  "status": "PENDING",
  "createdAt": "2026-07-07T08:30:00Z",
  "updatedAt": "2026-07-07T08:30:00Z"
}
```

Idempotency behaviour:

| Scenario | HTTP status | Result |
|----------|-------------|--------|
| First request | 201 | Payment created |
| Same key + same body | 200 | Original payment returned, no charge |
| Same key + different body | 409 | Rejected |

### Get payment

```
GET /api/v1/payments/7529bd27-a9f9-4bf0-a6b5-f9e120fda8ca
```

Response `200 OK`:

```json
{
  "paymentId": "7529bd27-a9f9-4bf0-a6b5-f9e120fda8ca",
  "organisationId": "8b24a9b4-58f5-42f1-a6ef-697cfb321164",
  "customerReference": "INV-2026-001",
  "amount": 1500.00,
  "currency": "KES",
  "status": "SUCCESS",
  "providerReference": "PROV-9837461",
  "createdAt": "2026-07-07T08:30:00Z",
  "updatedAt": "2026-07-07T08:30:01Z"
}
```

Payment statuses:

| Status | Meaning |
|--------|---------|
| `PENDING` | Created, awaiting worker pickup |
| `PROCESSING` | Worker has called the provider |
| `SUCCESS` | Provider accepted the payment |
| `FAILED` | Provider rejected with a reason |

Valid transitions: `PENDING -> PROCESSING -> SUCCESS` or `PROCESSING -> FAILED`. All others are rejected at the database level.

### Health check

```
GET /health
```

```json
{ "status": "ok" }
```

### Metrics

```
GET /metrics
```

Returns Prometheus text format. Key metrics:

```
payments_created_total
payments_success_total
payments_failed_total
provider_requests_total
provider_timeouts_total
idempotency_replays_total
idempotency_conflicts_total
payment_processing_duration_seconds
```

### Validation rules

- `organisationId` — required
- `customerReference` — required
- `amount` — required, greater than zero, max 2 decimal places
- `currency` — required, one of: `KES`, `USD`, `EUR`, `GBP`, `UGX`, `TZS`
- `recipient.type` — required, currently only `MOBILE_MONEY` is supported
- `recipient.phoneNumber` — required for `MOBILE_MONEY`
- `Idempotency-Key` header — required, max 128 characters

### Error responses

All errors follow this structure:

```json
{
  "error": "invalid_amount",
  "message": "Amount must be greater than zero"
}
```

---

## Project Structure

```
payment-api-service/
├── src/
│   ├── app.ts                        # Express app, /health, /metrics
│   ├── logger.ts                     # Structured JSON logger (winston)
│   ├── types.ts                      # Domain types and status transition map
│   ├── db/
│   │   └── migrate.ts                # Connection pool and migration runner
│   ├── metrics/
│   │   └── index.ts                  # Prometheus counters and histograms
│   ├── provider/
│   │   ├── client.ts                 # Provider HTTP client with typed errors
│   │   └── server.ts                 # Mock provider (configurable modes)
│   ├── repositories/
│   │   └── paymentRepository.ts      # All database queries
│   ├── routes/
│   │   └── payments.ts               # HTTP handlers
│   ├── services/
│   │   └── paymentService.ts         # Business logic and idempotency
│   ├── utils/
│   │   └── amountValidator.ts        # Minor-unit conversion via decimal.js
│   └── worker/
│       └── processor.ts              # Outbox worker (polls and processes)
├── tests/
│   ├── helpers.ts                    # DB setup/teardown and shared fixtures
│   ├── payments.test.ts              # Integration tests (25 test cases)
│   └── outbox.test.ts                # Outbox worker integration tests
├── migrations/
│   ├── 20260707000001_initial.sql    # payments and payment_attempts tables
│   └── 20260707000002_create_outbox.sql  # payment_outbox table
├── docs/
│   ├── ARCHITECTURE.md               # System design and technology choices
│   └── TECHNICAL_NOTE.md             # Design decisions and trade-offs
├── docker-compose.yml
├── Dockerfile
├── Dockerfile.provider
├── package.json
└── tsconfig.json
```

---

## Testing

Tests require only PostgreSQL — do not run the full Docker Compose stack while running tests. The worker container polls the same database, and if it is running it will race the test suite by processing outbox records that tests expect to control directly.

Start only the database, then run the suite:

```bash
# If the full stack is running, stop it first
docker compose down

# Start only PostgreSQL
docker compose up postgres -d

# Run the full test suite
DATABASE_URL=postgres://payments:payments@localhost:5432/payments \
PROVIDER_URL=http://localhost:4000 \
PROVIDER_TIMEOUT_MS=500 \
npm test
```

`PROVIDER_TIMEOUT_MS=500` keeps the timeout tests fast. Provider HTTP calls are intercepted with nock so no real provider process is needed.

26 integration tests across two suites:

| Suite | Tests | What is covered |
|-------|-------|-----------------|
| `payments.test.ts` | 24 | Create, get, idempotency, concurrency, validation, provider scenarios, observability |
| `outbox.test.ts` | 2 | Outbox worker end-to-end: providerRequestId reuse on retry, successful processing |

All tests run against a real PostgreSQL database. The concurrency test uses `Promise.all` to fire two identical requests simultaneously and asserts exactly one payment row is created.

---


---

## Documentation

- [docs/openapi.yaml](docs/openapi.yaml) — OpenAPI 3.0 spec (served as Swagger UI at `/docs` when the service is running)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — System design, technology choices, scalability considerations
- [docs/TECHNICAL_NOTE.md](docs/TECHNICAL_NOTE.md) — Idempotency implementation, concurrency strategy, trade-offs, known limitations, and production improvements
