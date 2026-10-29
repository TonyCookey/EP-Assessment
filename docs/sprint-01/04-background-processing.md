# 04 — Background processing

Status: complete and verified.

## Objective and dependencies

Demonstrate asynchronous processing, recovery, and clean shutdown. Depends on task 03.

## Implementation requirements

- Schedule after persistence; keep delays outside storage transactions and deduplicate active jobs.
- Default to a two-second, cancellable delay and deterministic saved success/decline scenarios.
- Convert unexpected simulator exceptions to `PROCESSING_ERROR`; handle every background rejection.
- Route completion through the shared finalization rule; do not overwrite manual results.
- Recover only processing records at startup, repeating the full configured delay.
- Mark readiness false on fatal storage failure, stop work, and signal nonzero exit.
- On SIGINT/SIGTERM, stop the listener, cancel waiting jobs, drain admitted work and writes, and enforce a five-second grace period.

## Tests and completion criteria

Controlled delays test success, decline, exceptions, manual races, cancellation, deduplicated scheduling, and restart recovery. Runtime tests verify readiness, idempotent shutdown, active-write draining, HTTP/background storage failure, grace timeout, and occupied-port cleanup. Unit tests must not sleep through the real simulation delay.
