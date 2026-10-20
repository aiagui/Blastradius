# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/aiagui/Blastradius/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aiagui/Blastradius/releases/tag/v0.1.0
