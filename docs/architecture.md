# Architecture decisions

These decisions capture the agreed assessment scope. Implementation uses one application with explicit module dependencies, not separately deployed components.

| Decision                                     | Rationale and consequence                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24, TypeScript strict ESM, Express 5    | Matches the requested stack and makes contracts explicit; runtime validation is still required.                                                                  |
| Immediate POST after persistence             | Reviewers can observe asynchronous processing. A returned payment is saved before its simulation is scheduled.                                                   |
| `processing → succeeded / failed`            | No unnecessary queue state. Final results are immutable; same-status repeats are no-ops.                                                                         |
| JSON persistence                             | Meets the simple-storage requirement and demonstrates asynchronous I/O; restricted to one process and a small dataset.                                           |
| Serialized repository transaction            | The check and mutation must share a serialization boundary, not merely the final disk write. This prevents duplicate keys and competing status overwrites.       |
| Atomic replacement and committed memory view | Failed writes cannot appear successful through subsequent reads. The original file remains the restart source. This is not database-grade power-loss durability. |
| Saved scenario and startup recovery          | In-process timers disappear on restart. Pending records resume with their saved scenario and a fresh delay; finalized records are skipped.                       |
| Optional persisted idempotency key           | Request retries return the existing current record. Keys share the payment commit and have no expiry. Business references remain nonunique.                      |
| Deterministic success/decline scenarios      | Reviewers can reproduce outcomes. Unexpected processor errors are injected in tests and become `PROCESSING_ERROR`.                                               |
| Fail-stop storage policy                     | Once commits fail, stop accepting work and shut down nonzero rather than serve an uncertain writable state.                                                      |
| No auth or external provider                 | This is a localhost simulation; real payment and account data are outside scope.                                                                                 |
| Vitest, Supertest, OpenAPI, CI               | Exercise domain, I/O, HTTP, restart behavior, and documented schemas with repeatable checks.                                                                     |

## Transaction boundary

Each mutation waits for earlier mutations, clones the last committed state, evaluates its rule, and writes only when something changes. The repository writes a uniquely named temporary file beside the destination, renames it over the destination, and then replaces its in-memory view. Readers receive copies of the last committed record, so a concurrent read may see the prior state while a write is in progress; it never sees an uncommitted result. A rejected business operation does not poison the queue. A storage error does.

The storage schema validates timestamps, lifecycle/failure-code consistency, UUID uniqueness, unique idempotency keys, and references to matching payment creation inputs. Startup rejects data that validation would silently normalize or default. Version 1 is the only supported storage format; no migration or automatic repair is attempted.

## Background work and shutdown

The coordinator registers one job per payment ID. Delay occurs outside the repository queue; completion uses the same conditional transition as PATCH. If manual completion commits first, automatic work is canceled or its conflicting result is discarded. Failed outcomes are application data, whereas failure to save an outcome is a fatal service event.

Shutdown marks readiness false, closes the listener, cancels waiting jobs, waits for active requests and processor jobs, then drains repository writes. This ordering includes writes enqueued by already-admitted HTTP requests. The grace period is five seconds. Pending saved records remain `processing` and resume on restart.

## Interfaces and ownership

- HTTP consumes `PaymentService`, coordinator scheduling/cancellation, a logger, and readiness.
- `PaymentService` owns creation and final-state rules; the repository owns the serialization boundary.
- The simulator accepts a payment and cancellation signal and returns an outcome. Its sleep function is injectable.
- `createRuntime` wires dependencies, lifecycle callbacks, storage, and the listener. The executable entry point owns process signals and exit status.
- Public OpenAPI schemas are checked against requests and responses in tests. Storage-only idempotency information is never returned as part of a payment.

## Deferred scope

Multiple service instances would require shared transactional storage and durable work coordination. Real payment side effects would require provider-level idempotency and reconciliation. Authentication, refunds, webhooks, TTL cleanup, finalized-payment retries, containers, and deployment remain outside this sprint.
