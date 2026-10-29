# Payment Processing Simulation

A REST API for creating payments, checking their status, and simulating payment processing in the background. Built with Node.js, TypeScript, and Express.

A new payment is saved with a `processing` status and returned immediately. The background processor then marks it as `succeeded` or `failed`. Payments are stored in a local JSON file, so unfinished payments can resume when the server restarts. No money is moved and no external payment provider is needed.

## Features

- Create and retrieve payments, with a separate endpoint for updating their status.
- Simulate successful payments and declines with a configurable processing delay.
- Retry creation requests safely using a persisted idempotency key.
- Recover unfinished payments after a restart and shut down gracefully.
- Validate requests, return consistent errors, and log requests without their bodies or customer details.
- Explore the API through Swagger UI, with automated tests and GitHub Actions checks.

## Getting started

You need **Node.js 24.x** and npm. No database or API credentials are required.

From the project directory:

```sh
nvm use # optional, if you use nvm
npm ci
npm run build
npm start
```

The server runs at `http://127.0.0.1:3000`. Open [Swagger UI](http://127.0.0.1:3000/docs/) to try the endpoints. The [OpenAPI specification](http://127.0.0.1:3000/openapi.json) is also available as JSON.

For development with automatic restarts:

```sh
npm run dev
```

The server creates `data/payments.json` on first startup. Stop it with Ctrl+C. Run only one server against a given data file; the storage implementation does not support multiple processes writing to the same file.

### Configuration

| Variable              | Default              | Purpose                                                                         |
| --------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `HOST`                | `127.0.0.1`          | Address to listen on                                                            |
| `PORT`                | `3000`               | Port, from 1 to 65535                                                           |
| `DATA_FILE`           | `data/payments.json` | Storage path, relative to the working directory or absolute                     |
| `SIMULATION_DELAY_MS` | `2000`               | Processing delay in milliseconds, from 0 to 2147483647                          |
| `LOG_LEVEL`           | `info`               | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |

Set variables in your shell, for example:

```sh
PORT=3001 SIMULATION_DELAY_MS=5000 npm start
```

An `.env.example` file is included. To use it, build the application first, then run:

```sh
cp .env.example .env
node --env-file=.env dist/server.js
```

`npm start` and `npm run dev` do not load `.env` automatically.

## API

Write requests require `Content-Type: application/json`. Request bodies are limited to 16 KiB, payment IDs must be UUIDs, and each response includes an `X-Request-Id` header.

| Method  | Endpoint               | Description                                                                           |
| ------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `POST`  | `/payments`            | Create a payment; returns `201`, or `200` for an idempotent replay                    |
| `GET`   | `/payments/:id`        | Retrieve a payment; returns `200`, or `404` if it does not exist                      |
| `PATCH` | `/payments/:id/status` | Finalize a processing payment; returns `200`, or `409` for a conflicting final status |
| `GET`   | `/health`              | Readiness check; returns `200` when ready, or `503` while unready and still reachable |

### Create a payment

```sh
curl -i -X POST http://127.0.0.1:3000/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1-attempt-1' \
  -d '{"amountMinor":1050,"currency":"NGN","customerId":"customer-1","merchantReference":"order-1"}'
```

| Field               | Required | Accepted values                                                   |
| ------------------- | -------- | ----------------------------------------------------------------- |
| `amountMinor`       | Yes      | Positive safe integer in minor units; `1050` means 10.50          |
| `currency`          | Yes      | `NGN`, `USD`, or `EUR`; no currency conversion                    |
| `customerId`        | Yes      | Trimmed string, 1–128 characters                                  |
| `merchantReference` | Yes      | Trimmed string, 1–128 characters; repeated references are allowed |
| `description`       | No       | Trimmed string, up to 500 characters                              |
| `simulation`        | No       | `success` (default) or `decline`                                  |

Numeric strings, fractional amounts, and unknown fields are rejected. IDs, status, failure codes, and timestamps are set by the server. Customer identifiers are labels and are not checked against an external system.

Example `201 Created` response (ID and timestamps are illustrative):

```json
{
  "amountMinor": 1050,
  "currency": "NGN",
  "customerId": "customer-1",
  "merchantReference": "order-1",
  "simulation": "success",
  "id": "00000000-0000-4000-8000-000000000001",
  "status": "processing",
  "failureCode": null,
  "createdAt": "2026-10-27T12:00:00.000Z",
  "updatedAt": "2026-10-27T12:00:00.000Z"
}
```

The response also includes `Location: /payments/<id>`. Use the returned ID to check the result:

```sh
PAYMENT_ID='paste-the-returned-id-here'
curl -i "http://127.0.0.1:3000/payments/$PAYMENT_ID"
```

After the processing delay, the status becomes `succeeded`. To simulate a failure, include `"simulation":"decline"` in a new creation request. That payment will finish with status `failed` and failure code `DECLINED`.

### Update a payment's status

A processing payment can be finalized manually as `succeeded` or `failed`:

```sh
curl -i -X PATCH "http://127.0.0.1:3000/payments/$PAYMENT_ID/status" \
  -H 'Content-Type: application/json' \
  -d '{"status":"failed"}'
```

To try this before the background processor finishes, restart the server with `SIMULATION_DELAY_MS=60000 npm start`, create a new payment, and set `PAYMENT_ID` to its ID.

A manual failure uses the code `MANUAL_FAILURE`. Repeating the same final status returns the existing payment without changing its timestamp or failure code. Changing a final status returns `409 STATUS_CONFLICT`. If manual and background updates happen together, the first committed result wins.

### Retry a creation request

The optional `Idempotency-Key` header prevents duplicate payments when a client retries a request. Reusing a key with equivalent input returns the original payment's current state with `200`. Reusing it with different input returns `409 IDEMPOTENCY_CONFLICT`. Without a key, every valid request creates a new payment.

Keys are case-sensitive, accept 1–128 visible ASCII characters without spaces, and survive restarts. Text is trimmed and the default simulation is applied before input is compared. Property order does not matter; an omitted description and an empty description are different. Keys do not expire.

### Errors

Errors use a consistent response format. Validation errors also include field details:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "requestId": "00000000-0000-4000-8000-000000000002",
    "details": [{ "field": "amountMinor", "message": "Invalid input" }]
  }
}
```

| Status | Examples                                                 |
| ------ | -------------------------------------------------------- |
| `400`  | Invalid fields, malformed JSON, or invalid path encoding |
| `404`  | Payment or endpoint not found                            |
| `409`  | Conflicting idempotency key or final status              |
| `413`  | Request body exceeds 16 KiB                              |
| `415`  | Unsupported content type or encoding                     |
| `500`  | Unexpected error; internal details are not returned      |
| `503`  | Storage failure or service unavailable                   |

A simulated decline is a payment outcome, not an HTTP service error. Unexpected simulator exceptions produce a failed payment with `PROCESSING_ERROR`; tests exercise this through injected failures.

## Storage and background processing

Payments and idempotency keys are saved together. Writes are serialized and use a temporary file followed by a rename; the in-memory state changes only after the write succeeds. This prevents concurrent requests from overwriting each other's results.

On startup, the server validates the stored data and resumes payments still marked `processing`. Each resumed payment waits for the full configured delay. Finalized payments are left unchanged. To try recovery, create a payment with a long delay, stop the server, and restart it using the same data file.

Corrupt storage prevents startup rather than being replaced with an empty file. A runtime storage failure stops new work and shuts the server down with a nonzero exit code. After the storage issue is repaired, restarting the server resumes pending payments.

SIGINT and SIGTERM stop new requests, cancel waiting simulations, and allow active requests and writes up to five seconds to finish. Logs are structured JSON and exclude request bodies, raw customer/reference values, idempotency keys, and raw exception messages.

This is an unauthenticated local simulation. Storage is intended for a small dataset owned by one process; it rewrites the full JSON document for each change. Atomic rename does not guarantee durability through power loss. There is no external queue, real payment integration, or automatic record cleanup. See [architecture decisions](docs/architecture.md) for the implementation details and tradeoffs.

## Testing

Install dependencies with `npm ci`, then run:

```sh
npm test                  # unit, repository, HTTP, and lifecycle tests
npm run test:watch        # watch mode
npm run test:coverage     # coverage report in coverage/index.html
npm run check             # lint, formatting, typecheck, coverage tests, and build
npm run smoke             # compiled-server checks; run npm run build first
```

Tests cover validation, status transitions, concurrent requests, idempotency, write failures, restart recovery, shutdown, error responses, logging, and the OpenAPI contract. They use temporary storage and controlled simulation delays. HTTP tests require permission to bind localhost ports.

The smoke test starts real server processes and checks the API, success and decline scenarios, persistence across restarts, documentation endpoints, and shutdown. GitHub Actions runs `npm ci`, `npm run check`, and `npm run smoke`.

## Project structure

```text
src/
  app.ts          Express routes and error handling
  domain.ts       Payment types and validation
  service.ts      Payment creation and status rules
  repository.ts   JSON storage and serialized writes
  processor.ts    Background simulation and cancellation
  runtime.ts      Startup, recovery, and shutdown
  server.ts       Entry point and process signals
  config.ts       Environment configuration
  logger.ts       Structured logging
  errors.ts       Application errors
  openapi.ts      API specification
scripts/          Compiled-server smoke test
tests/           Automated tests
docs/             Architecture and task records
```
