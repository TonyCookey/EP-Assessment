# 02 — Persistence

Status: complete and verified.

## Objective and dependencies

Provide safe single-process JSON persistence. Depends on task 01.

## Implementation requirements

- Store versioned payments and idempotency entries in one document.
- Initialize absent storage; validate existing records and references before serving traffic.
- Reject corrupt, unsupported, or inconsistent storage without overwriting it.
- Serialize complete read/check/write operations. Return copies and expose only committed state.
- Write a temporary file in the destination directory, rename it atomically, and clean up temporary files on ordinary failures.
- Support draining writes and a fatal storage callback. Domain conflicts must not poison the queue.
- Keep the atomic writer injectable for deterministic fault and timing tests.

## Tests and completion criteria

Temporary-file tests demonstrate reload, isolated returned objects, concurrency, blocked commits, unchanged files on failed writes, invalid storage rejection, temp cleanup, and draining. A failing write marks the repository unhealthy and invokes the failure callback once. No cross-process locking or migration framework is introduced.
