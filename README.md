# Payment API Service

A production-grade payment processing API built with Node.js, TypeScript, and PostgreSQL. Designed to handle financial transactions with strong idempotency guarantees, concurrency safety, and transparent status tracking.

## 📋 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Quick Start](#quick-start)
- [Local Development](#local-development)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Production Considerations](#production-considerations)

---

## Overview

The Payment API Service solves a critical problem in payment processing: **reliably handling financial transactions without duplicates, race conditions, or silent failures**.

### The Problem This Solves

1. **Duplicate Charges**: Network timeouts can cause clients to retry requests. Without idempotency, the same payment could be charged twice.
2. **Race Conditions**: Concurrent requests with identical bodies could slip through validation if not carefully synchronized.
3. **Uncertain States**: Timeouts leave payments in an ambiguous state—did the provider receive it? Was it charged?
4. **Slow APIs**: Synchronous provider calls block the API response, creating poor UX and high failure rates.

### The Solution

This API implements **database-enforced idempotency** with **PostgreSQL advisory locks** and **SERIALIZABLE isolation** to guarantee:

- ✅ Same request replayed with same key → Same result (never charged twice)
- ✅ Multiple concurrent requests → No race conditions  
- ✅ Provider timeout → Clear PROCESSING status (uncertainty is explicit)
- ✅ Fast API responses → Return in ~20ms, process provider call async

---

## Key Features

### 🔐 Strong Idempotency Guarantees
- Enforced at database level with UNIQUE constraint on `(organisation_id, idempotency_key)`
- PostgreSQL advisory locks prevent TOCTOU (time-of-check-time-of-use) race conditions
- SERIALIZABLE isolation prevents phantom reads and concurrent anomalies
- **No duplicate charges ever**, even across multiple app replicas

### 🚀 Fast API Responses
- Payment creation returns in ~20ms (just database write)
- Provider calls processed asynchronously (fire-and-forget pattern)
- No synchronous blocking on external services

### 📊 Clear Status Tracking
- `PENDING` → `PROCESSING` → `SUCCESS`/`FAILED`
- Explicit status model prevents ambiguous states
- Timeout leaves payment in `PROCESSING` (client can retry safely)

### 🔍 Full Observability
- Health check endpoint (`/health`) for load balancer integration
- Prometheus metrics endpoint (`/metrics`) for monitoring
- Structured JSON logging for debugging and audit trails

### 🧪 Comprehensive Testing
- 24 test cases covering happy paths, edge cases, and concurrency scenarios
- Full integration testing with real database and mocked provider
- Scenario testing for provider timeouts, rejections, and retries

---

## System Architecture

For detailed architecture documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

### High-Level Flow

```
Client Request
    ↓
API Layer (validation + idempotency check)
    ↓
PostgreSQL (atomic transaction with advisory lock)
    ↓
Return 201 Created (immediately)
    ↓
Async Handler (process provider call)
    ↓
Update payment status (SUCCESS/FAILED/PROCESSING)
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Advisory Locks + SERIALIZABLE Isolation** | Prevents race conditions across multiple servers |
| **Fire-and-Forget Async** | Decouples API response from provider latency |
| **PROCESSING Status on Timeout** | Transparent about uncertainty; prevents double-charging |
| **Request Hash** | Deterministic conflict detection across request resubmissions |
| **Database-Level Constraints** | Single source of truth; survives server restarts |

---

## Quick Start

### Docker Compose (Recommended for Development)

```bash
# Start everything (PostgreSQL + Mock Provider + API)
docker compose up --build

# Verify services
curl http://localhost:3000/health
curl http://localhost:3000/metrics

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
curl http://localhost:3000/api/v1/payments/:paymentId
```

### Services

| Service | URL | Purpose |
|---------|-----|---------|
| **API** | http://localhost:3000 | Payment API |
| **Mock Provider** | http://localhost:4000 | Simulated payment provider |
| **Metrics** | http://localhost:3000/metrics | Prometheus metrics |
| **Health** | http://localhost:3000/health | Health check |

---

## Local Development

### Prerequisites

- Node.js 18+
- PostgreSQL 15+ (or Docker for postgres:16-alpine)
- npm 8+

### Setup

```bash
# Install dependencies
npm install

# Start PostgreSQL (in Docker)
docker run -d \
  --name payments-db \
  -e POSTGRES_USER=payments \
  -e POSTGRES_PASSWORD=payments \
  -e POSTGRES_DB=payments \
  -p 5432:5432 \
  postgres:16-alpine

# Set environment
export DATABASE_URL=postgres://payments:payments@localhost:5432/payments
export PROVIDER_URL=http://localhost:4000
export PROVIDER_TIMEOUT_MS=5000

# Run migrations
npm run migrate

# In Terminal 1: Start mock provider
PROVIDER_MODE=success npx ts-node src/provider/server.ts

# In Terminal 2: Start API in watch mode
npm run dev

# Verify
curl http://localhost:3000/health
```

### Available Commands

```bash
npm run build       # Compile TypeScript to dist/
npm run dev         # Start dev server with hot reload (ts-node)
npm run migrate     # Run database migrations
npm test            # Run test suite
npm run test:watch  # Run tests in watch mode
npm run lint        # Check TypeScript (tsc)
```

---

## API Reference

### Create Payment

**Request**
```http
POST /api/v1/payments
Idempotency-Key: <uuid>
Content-Type: application/json

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

**Response** (201 Created)
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

**Idempotency Behavior**

| Scenario | Status | Response |
|----------|--------|----------|
| First request | 201 | Created payment |
| Replay with **same key + same body** | 200 | Original response (no charge) |
| Replay with **same key + different body** | 409 | Conflict (resolve offline) |

### Get Payment

**Request**
```http
GET /api/v1/payments/7529bd27-a9f9-4bf0-a6b5-f9e120fda8ca
```

**Response** (200 OK)
```json
{
  "paymentId": "7529bd27-a9f9-4bf0-a6b5-f9e120fda8ca",
  "organisationId": "8b24a9b4-58f5-42f1-a6ef-697cfb321164",
  "customerReference": "INV-2026-001",
  "amount": 1500.00,
  "currency": "KES",
  "status": "SUCCESS",
  "providerReference": "TX-2026-12345",
  "createdAt": "2026-07-07T08:30:00Z",
  "updatedAt": "2026-07-07T08:30:01Z"
}
```

**Status Values**

| Status | Meaning | Final? |
|--------|---------|--------|
| `PENDING` | Payment created, awaiting processing | ❌ |
| `PROCESSING` | In flight with provider (uncertain state) | ❌ |
| `SUCCESS` | Provider accepted, money charged | ✅ |
| `FAILED` | Provider rejected with reason | ✅ |

### Health Check

**Request**
```http
GET /health
```

**Response** (200 OK)
```json
{
  "ok": true
}
```

### Metrics

**Request**
```http
GET /metrics
```

**Response** (text/plain, Prometheus format)
```
# HELP payment_requests_total Total number of payment requests
# TYPE payment_requests_total counter
payment_requests_total{status="created"} 42

# HELP payment_requests_processing Current payments processing
# TYPE payment_requests_processing gauge
payment_requests_processing 3
```

---

## Project Structure

```
payment-api-service/
├── src/
│   ├── app.ts                 # Express app setup
│   ├── logger.ts              # Structured logging
│   ├── types.ts               # TypeScript interfaces + constants
│   ├── db/
│   │   └── migrate.ts         # Database migration runner
│   ├── middleware/            # Express middleware (unused)
│   ├── metrics/
│   │   └── index.ts           # Prometheus metrics collection
│   ├── provider/
│   │   ├── client.ts          # Provider API client
│   │   └── server.ts          # Mock provider service
│   ├── repositories/
│   │   └── paymentRepository.ts  # Database queries
│   ├── routes/
│   │   └── payments.ts        # Route handlers
│   └── services/
│       └── paymentService.ts  # Business logic
├── tests/
│   ├── helpers.ts             # Test utilities + fixtures
│   └── payments.test.ts       # Integration tests (24 test cases)
├── migrations/
│   └── 001_initial.sql        # Database schema
├── Dockerfile                 # Production image
├── Dockerfile.provider        # Mock provider image
├── docker-compose.yml         # Local dev environment
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript config
├── ARCHITECTURE.md            # System design document
├── TECHNICAL_NOTE.md          # Design decisions + production improvements
├── README.md                  # This file
└── .gitignore                 # Git ignore rules
```

### File Organization Rationale

**By Layer** (`services/`, `repositories/`, `routes/`):
- Separates concerns: business logic, database queries, HTTP handlers
- Makes testing easier: mock each layer independently
- Standard Express app structure, familiar to Node.js developers

**Single Source of Truth**:
- All database operations go through `paymentRepository`
- All business logic centralized in `paymentService`
- No business logic in route handlers

**Provider Integration**:
- `client.ts`: Calls real provider (production) or mock
- `server.ts`: Mock provider for testing
- Allows testing without external service dependency

---

## Testing

### Running Tests

```bash
# Requires running PostgreSQL instance
docker run -d --name payments-db \
  -e POSTGRES_USER=payments \
  -e POSTGRES_PASSWORD=payments \
  -e POSTGRES_DB=payments \
  -p 5432:5432 \
  postgres:16-alpine

# Run test suite
DATABASE_URL=postgres://payments:payments@localhost:5432/payments npm test

# Watch mode
npm run test:watch

# Coverage (generates coverage/ directory)
npm test -- --coverage
```

### Test Coverage

**24 comprehensive test cases** covering:

| Category | Tests | Coverage |
|----------|-------|----------|
| Happy Path | 11 | Create, get, provider success/failure/timeout |
| Idempotency | 3 | Replayed request, conflicts, key validation |
| Validation | 4 | Recipient types, amounts, currencies |
| Concurrency | 2 | Multiple clients, simultaneous GETs |
| Edge Cases | 2 | Scenario 7 (timeout + retry), response format |
| Observability | 2 | Health check, metrics endpoint |

**Key Test Scenarios**

1. **Create Payment**: Returns 201 with payment ID and PENDING status
2. **Replayed Request**: Same key + same body → 200 OK (cached)
3. **Conflict**: Same key + different body → 409 Conflict
4. **Provider Success**: Payment moves to SUCCESS with provider reference
5. **Provider Failure**: Payment moves to FAILED with reason code
6. **Provider Timeout**: Payment stays PROCESSING (async timeout doesn't block API)
7. **Scenario 7**: Timeout + retry with same key → No duplicate provider charge
8. **Concurrent Gets**: Multiple clients querying same payment simultaneously
9. **Response Format**: Optional fields included/excluded correctly
10. **Validation**: Rejects invalid amounts, unsupported recipient types, missing fields

---

## Deployment

### Docker Image

```bash
# Build image
docker build -t payment-api:latest .

# Run image
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@db:5432/payments \
  -e PROVIDER_URL=https://provider.example.com \
  -e PROVIDER_TIMEOUT_MS=5000 \
  payment-api:latest
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | *required* | PostgreSQL connection string |
| `PROVIDER_URL` | http://localhost:4000 | Payment provider base URL |
| `PROVIDER_TIMEOUT_MS` | 5000 | Provider request timeout (ms) |
| `PORT` | 3000 | HTTP server port |
| `NODE_ENV` | development | Node environment |

### Production Checklist

- [ ] PostgreSQL instance (managed RDS recommended)
- [ ] Multiple API instances behind load balancer
- [ ] Monitoring stack (Prometheus + Grafana)
- [ ] Alerting rules (payment failure spike, API latency)
- [ ] CI/CD pipeline (automated tests, type checking)
- [ ] Authentication/authorization layer
- [ ] Rate limiting and DDoS protection
- [ ] Database backups and recovery testing
- [ ] Log aggregation (CloudWatch, DataDog, etc.)
- [ ] Async worker pool for provider processing

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed production improvements.

---

## Production Considerations

### Current Limitations

The current implementation is optimized for correctness and clarity. For production deployment, consider:

1. **Authentication**: Add API key or OAuth2 authentication
2. **Authorization**: Verify caller can only access own organization
3. **Rate Limiting**: Per-organization rate limits
4. **Encryption**: TLS for network traffic, encryption at rest for PII
5. **Async Queue**: External message queue (RabbitMQ, SQS) for provider processing
6. **Circuit Breaker**: Handle degraded provider availability
7. **Reconciliation Job**: Detect stale PROCESSING payments
8. **Webhook Callbacks**: Notify client on completion instead of polling
9. **Idempotency Expiry**: Clean up old idempotency keys
10. **Distributed Tracing**: OpenTelemetry integration for observability

See [TECHNICAL_NOTE.md](TECHNICAL_NOTE.md) for detailed recommendations.

---

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)**: System design, core principles, scalability considerations
- **[TECHNICAL_NOTE.md](TECHNICAL_NOTE.md)**: Design decisions, trade-offs, production improvements

---

## Contributing

### Code Style

- TypeScript with strict mode enabled
- ESM modules (no CommonJS)
- Consistent naming: camelCase for functions/variables, PascalCase for types
- Structured logging (JSON format)

