# 03 — Payment rules

Status: complete and verified.

## Objective and dependencies

Implement normalized creation, duplicate protection, retrieval, and immutable final outcomes. Depends on task 02.

## Implementation requirements

- Validate positive safe integer minor amounts, NGN/USD/EUR, required identifiers, optional description, and deterministic scenarios.
- Reject unknown fields and numeric coercion. Generate UUIDs, UTC timestamps, status, and failure codes.
- Save an optional key and normalized request with the payment in one transaction.
- Replay equivalent requests using the existing current record; reject differing requests with 409. Keys are case-sensitive and retained indefinitely.
- Allow repeated merchant references and independent creations without keys.
- Finalize processing payments only; identical final status is a no-op and conflicting final status returns 409.

## Tests and completion criteria

Validate boundaries and normalization. Concurrent requests using one key create exactly one payment. Conflicting key reuse leaves the transaction queue usable. Competing finalizations have one winner; repeated finalization preserves timestamps and failure codes. Reopened storage still supports idempotent replay.
