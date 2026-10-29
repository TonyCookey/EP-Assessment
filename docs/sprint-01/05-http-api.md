# 05 — HTTP API

Status: complete and verified.

## Objective and dependencies

Expose the agreed contract with consistent validation, errors, and logs. Depends on task 04.

## Implementation requirements

- Implement POST /payments, GET /payments/:id, and PATCH /payments/:id/status.
- Return 201 on new creation, 200 on replay, and Location for both.
- Add readiness, Swagger UI, and the OpenAPI document.
- Require JSON on write requests, cap bodies at 16 KiB, and validate UUIDs and single idempotency headers.
- Generate request IDs and use the agreed JSON error envelope/status codes.
- Log route templates, timing, result status, and request IDs without bodies, arbitrary URLs, keys, or raw business identifiers.

## Tests and completion criteria

Supertest verifies success, replay, concurrent creation, finalization, all relevant client errors, storage unavailability, and sanitized unexpected failures. AJV validates OpenAPI request examples and payment/error responses. Swagger HTML and health endpoints work. Log-capture tests confirm required fields and excluded inputs.
