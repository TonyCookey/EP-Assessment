# 01 — Foundation

Status: complete and verified.

## Objective and dependencies

Establish the agreed Node.js 24 / TypeScript / Express 5 foundation. Depends on the approved architecture; no earlier implementation task.

## Implementation requirements

- Initialize local Git on `main`; ignore dependencies, data, environment overrides, builds, and coverage.
- Use strict ESM TypeScript, npm with lockfile, tsx development, and tsc compilation.
- Provide development, build, start, typecheck, lint, formatting, test, coverage, check, and smoke scripts.
- Validate host, port, data path, delay, and log level; provide `.env.example` without automatically loading it.
- Separate app construction from process startup and add Pino logging without raw request data.
- Add GitHub Actions using Node 24 and clean lockfile installation.

## Tests and completion criteria

Configuration tests cover defaults, valid overrides, and invalid limits. `npm run typecheck`, `npm run lint`, and `npm run build` succeed. Importing application modules does not open a listener. The dependency lockfile is committed and generated/runtime paths are ignored.
