# Sprint 01 — Payment processing simulation

Objective: deliver a focused, robust hiring assessment with a reproducible local setup, meaningful tests, API documentation, and CI. This is one dependency-ordered sprint with no calendar deadline.

Status: complete

| Order | Task                                                     | Depends on    |
| ----- | -------------------------------------------------------- | ------------- |
| 01    | [Foundation](01-foundation.md)                           | Agreed design |
| 02    | [Persistence](02-persistence.md)                         | 01            |
| 03    | [Payment rules](03-payment-rules.md)                     | 02            |
| 04    | [Background processing](04-background-processing.md)     | 03            |
| 05    | [HTTP API](05-http-api.md)                               | 04            |
| 06    | [Documentation and handoff](06-documentation-handoff.md) | 01–05         |

Execute tasks in order; tests accompany the behavior they verify. Each task file records implementation boundaries and acceptance checks so it can also guide later maintenance.

## Definition of done

- `npm ci` succeeds from the committed lockfile.
- `npm run check` passes lint, formatting, TypeScript checks, coverage tests, and build.
- `npm run smoke` passes against the compiled entry point with temporary data.
- README examples, OpenAPI schemas, and actual API behavior agree.
- Pending records and idempotency survive restart; finalized records remain immutable.
- Logs omit sensitive inputs and failures have consistent responses.
- Git excludes runtime data, secrets, dependencies, and generated output.
- Local repository is ready for the submitter to publish; publishing is not an implementation task.

## Verification results

- Clean lockfile installation passed using `npm ci` with a populated offline cache.
- `npm run check` passed: lint, formatting, strict TypeScript checks, 79 tests across five files, coverage, and compilation.
- Reported coverage: 99.68% lines, 98.84% statements, and 94.44% branches. The executable signal/exit entry point is excluded from unit coverage and exercised by the smoke test.
- `npm run smoke` passed: compiled service, create/get/update, success/decline, persisted idempotency, restart recovery, finalized-record preservation, Swagger/OpenAPI, and graceful process shutdown.
- GitHub Actions is configured with the same check and smoke commands; remote CI will run after the submitter publishes the repository.

Local HTTP tests and smoke verification required permission to bind localhost listeners outside the execution sandbox. This is an environment restriction, not a service dependency.
