# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-21

### Security

- The installed bin now starts Node with `--` (`#!/usr/bin/env -S node --`), so `--env-file*` passed to the bin no longer reaches Node's own option parser. Calling `node path/to/cli.js --env-file …` yourself still lets Node read the file. `--experimental-*config-file` is still loaded by Node even after `--`; never pass those flags. Needs `env -S` (GNU coreutils ≥ 8.30, FreeBSD/macOS). On Alpine install `coreutils-env`; BusyBox `env` has no `-S`.
- Argument parse errors redact token-shaped substrings before printing to stderr.
- `.env` files that are not regular files, that are larger than 1 MiB, or whose symlink target resolves outside `--dir` are skipped (with a stderr note). On Linux/macOS the file is opened once with `O_NOFOLLOW|O_NONBLOCK` and read through that fd (closes the symlink/FIFO TOCTOU race). Windows falls back to realpath-then-open.

### Added

- Detects GitHub App refresh tokens (`ghr_`) and Stripe webhook signing secrets (`whsec_`). Both are reported offline; refresh tokens are never sent to the API.

### Changed

- The package is no longer published to npm. Install by cloning a release
  tag, then `npm ci && npm install -g .` (or `node dist/cli.js`). The release
  workflow only creates the GitHub release. `package.json` is `"private": true`.

## [0.2.0] - 2026-10-21

### Security

- The CLI no longer accepts command-line flags that Node.js also reads as its own options. Details will follow in a security advisory.

### Changed

- **Breaking:** `--env-file <name>` is now `--file <name>`; `-f` is unchanged. Node.js treats `--env-file` as its own option even after the script name ([nodejs/node#54232](https://github.com/nodejs/node/issues/54232)), so `--dir <other> --env-file <name>` could fail with `node: <name>: not found` (exit 9).
- Passing `--env-file`, `--env-file-if-exists`, `--experimental-config-file` or `--experimental-default-config-file` (with or without `=…`) now exits with code 2 and points to `--file`. Node.js still reads such a file before blastradius starts; this check only stops the flag from looking like it works. Use `-f`/`--file`.

## [0.1.0] - 2026-10-20

First release, published to npm as `@aiagui/blastradius` (the command is `blastradius`).

### Added

- `blastradius` CLI with `--dir`, `--env-file`, `--offline`, `--json`, `--fail-on` and `--no-color`; strict TypeScript, ESM, Node >= 22.13, zero runtime dependencies.
- dotenv parser for `.env*` files (skips `*.example`, `*.sample`, `*.template`).
- `Secret` type with redacted string, JSON and inspect output.
- `safeFetch`, the only network primitive: per-connector allowlists, GraphQL by document hash, host binding for secrets, no redirects, `discardBody`.
- `Connector` interface and an example template connector (test-only).
- Connectors register themselves: `scripts/gen-connectors.mjs` builds the registry from every `src/connectors/<id>.ts` that exports `connector`, so adding a connector never edits a shared file.
- Terminal and JSON reports with an output leak guard.
- GitHub connector: classic, OAuth, legacy, fine-grained and GitHub App tokens; scopes from `X-OAuth-Scopes`, fine-grained permissions reported as unknown (never green); a 401 is green/inferred because GitHub Enterprise Server tokens share the prefixes.
- Stripe connector: classifies `sk_`, `rk_` and `pk_` keys (live/test), confirms secret keys with one `GET /v1/balance`, probes restricted keys with read-only calls (bodies discarded), says why a probe failed (blocked, unreachable or the HTTP status) and always reports write permissions as unknown. A rejected live key stays amber; rejected test keys are green/inferred.
- Vercel connector: `vcp_`/`vci_`/`vca_`/`vcr_` and legacy tokens; risk from token scope (full account or team) and team role; flags tokens Vercel marked as leaked.
- README with a PNG banner (SVG sources kept in `docs/assets/`), badges, red/amber/green legend, demo GIF recorded offline on fake keys, example output from the real CLI, and collapsible technical sections.
- CI on GitHub Actions: typecheck, lint (bans direct network APIs), tests including a canary leak test, build and offline smoke tests (basic fixture and canary) on Node 22 and 24; opt-in CodeQL scanning (`ENABLE_CODEQL`); Dependabot for npm and GitHub Actions updates; secret scanning ignores `test/`. Fake-credential fixtures with real key formats are generated at test time (`scripts/make-fixture.mjs`), never committed.
- Release workflow: a `v*` tag runs the full checks and the canary smoke test, checks the tag against the package version, publishes to npm with provenance and creates the GitHub release from this changelog.
- `SECURITY.md` (private vulnerability reporting) and `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).

### Fixed

- The example template connector is never registered in the CLI, so it cannot report fake findings in real scans.

[Unreleased]: https://github.com/aiagui/Blastradius/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/aiagui/Blastradius/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aiagui/Blastradius/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aiagui/Blastradius/releases/tag/v0.1.0
