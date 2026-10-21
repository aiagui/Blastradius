<p align="center">
  <img src="docs/assets/banner.png" alt="blastradius: concentric red, amber and green rings next to the name" width="640">
</p>

<p align="center">

[![CI](https://github.com/aiagui/Blastradius/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aiagui/Blastradius/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![node 22.13+](https://img.shields.io/badge/node-22.13%2B-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Read-only checks](https://img.shields.io/badge/checks-read--only-informational)

</p>

<h3 align="center">What could someone do with the secrets in your <code>.env</code>?</h3>

<p align="center">
A leaked token is only as scary as what it can do. <code>blastradius</code> tells you, in seconds,<br>
which of your credentials could move money, write to production, or are already harmless.
</p>

---

`blastradius` reads the `.env` files in your project, finds credentials for the
services it knows, checks each one **live and read-only** against the service
that issued it, and prints a red / amber / green report of what it can actually do.

v0.1 checks **GitHub**, **Vercel** and **Stripe** credentials.

<p align="center">
  <img src="docs/assets/demo.gif" alt="blastradius running in a terminal against fake keys with --offline, showing one red, two amber and one green result" width="900">
</p>
<p align="center"><sub>Recorded with <code>--offline</code> against obviously fake keys. Nothing was sent anywhere.</sub></p>

## Quick start

Needs Node 22.13 or newer. This package is **not** published to npm; install it from this repository.

```sh
git clone https://github.com/aiagui/Blastradius.git
cd Blastradius
git checkout v0.2.1   # or main
npm ci                # runs prepare and builds dist/
npm install -g .      # puts blastradius on your PATH
blastradius --dir ~/code/your-project
```

Or run the built file without a global install:

```sh
node dist/cli.js --dir ~/code/your-project
```

`npm install -g github:aiagui/Blastradius#v0.2.1` (global install from a git URL) **fails today**: the nested prepare build cannot see TypeScript. A **project-local** `npm install github:aiagui/Blastradius#v0.2.1` and `npx github:aiagui/Blastradius …` do work. Prefer the clone path above. If you use npx, pass `--` before blastradius flags (`npx -- github:aiagui/Blastradius -f .env`), so Node does not treat `--env-file` as its own option.

`npm install -g .` after a clone **symlinks** the global install to that clone (it is not a copy). Moving or deleting the clone breaks the command; a `git pull` without rebuilding leaves a stale `dist/`.

Want to try it without touching the network first? Add `--offline`.

The installed bin starts with `#!/usr/bin/env -S node --`. That needs an `env` that supports `-S` (GNU coreutils ≥ 8.30, FreeBSD/macOS). On Alpine install `coreutils-env`; BusyBox `env` has no `-S` and the bin will not start. Prefer the installed bin over calling `node dist/cli.js` with flags Node also reads (`--env-file*`, `--experimental-*config-file`).

## Reading the report

Every credential gets one of three levels:

| Level | Meaning | Examples |
| :---: | --- | --- |
| 🔴 **red** | Can do real damage. | Move money, write to production, delete things. |
| 🟠 **amber** | Can read sensitive data, or we could not rule out damage. | Private repos readable, permissions hidden by the provider, a check that failed. |
| 🟢 **green** | Harmless or revoked. | A publishable key, a token the provider rejected. |

…and says how sure it is:

| Confidence | Meaning |
| --- | --- |
| **confirmed** | Checked live against the provider. |
| **inferred** | From the credential format or a partial check. |
| **unknown** | We could not tell. |

> [!IMPORTANT]
> **Unknown is never reported as green.** If a check fails or the provider hides
> the answer, you get amber, not a false sense of safety.

### Example output

```text
blastradius 0.1.0  ~/code/acme-web
Scanned: .env, .env.local

● RED    GitHub  GITHUB_TOKEN  ghp_… (40 chars)  in .env.local  [confirmed]
         Classic scopes allow destructive or production writes: repo. (user acme-dev)
         write_repos=true  read_private_repos=true
         → Replace it with a fine-grained token limited to the repositories and permissions this app needs, then revoke this one.

● RED    Stripe  STRIPE_SECRET_KEY  sk_live_… (48 chars)  in .env  [confirmed]
         Live secret key: full access to real payments, refunds, payouts and customer data.
         read=true  write=true  move_money=true
         → Replace it with a restricted key (rk_live_) that only has the permissions this project needs, then roll this key in the Dashboard.

● GREEN  Vercel  VERCEL_TOKEN  … (24 chars)  in .env  [inferred]
         Vercel rejected this token: revoked, expired or invalid.
         → Confirm in the Vercel dashboard (Account Settings > Tokens) that it is gone, then remove it from your .env files.

3 credentials: 2 red, 0 amber, 1 green
```

*(Real output format from a run on fake keys, with the provider responses mocked: a `repo`-scoped GitHub token, a live Stripe secret key and a Vercel token that Vercel rejected.)*

## Built to be safe to run

Pointing a tool at your secrets should not be a risk in itself. In short:
**read-only**, **secrets only go to the service that issued them**, **secrets are
never printed**, and **zero runtime dependencies**. The details are below.

<details>
<summary><b>Safety guarantees</b> (enforced by code and CI, not just promised)</summary>

<br>

- **Read-only.** All network access goes through one function,
  [`safeFetch`](src/net/safeFetch.ts), with a per-connector allowlist of exact
  method + host + path. `PUT`, `PATCH` and `DELETE` can never be allowlisted;
  `POST` is only allowed for GraphQL query documents whose SHA-256 matches a
  constant in the code, and mutations are rejected. A lint rule fails CI if any
  other file uses `fetch`, `http`, `https` or `undici`.
- **Secrets go only to their issuer.** Each credential is bound to the hosts of
  the service that issued it (e.g. a Stripe key can only be sent to
  `api.stripe.com`). No telemetry, no third parties.
- **Secrets are never printed.** Values are wrapped in a `Secret` type whose
  `toString`, `toJSON` and `inspect` are redacted. Only the public prefix and
  length are shown. Before anything is printed, the output is scanned for every
  secret value and the run aborts if one is found. A canary test runs the full
  CLI against fake secrets and fails if any of them shows up in stdout, stderr
  or the JSON report.
- **Minimal footprint.** Zero runtime dependencies.

</details>

<details>
<summary><b>What requests each connector makes</b></summary>

<br>

Checking a credential is visible to its provider (for example in Stripe's
Dashboard request logs or GitHub's security log), like any API call.

- **GitHub:** at most two `GET` requests to `api.github.com` (`/user`, and
  `/user/repos?visibility=private&per_page=1` for tokens that hide their
  permissions). Updates the token's "last used" time.
- **Stripe:** secret keys: one `GET /v1/balance`; restricted keys: up to three
  read-only `GET` calls (`/v1/balance`, plus `/v1/charges` and `/v1/customers`
  with `limit=1`). Bodies are always discarded. Publishable keys are never sent.
- **Vercel:** at most four `GET` requests to `api.vercel.com`
  (`/v5/user/tokens/current`, then `/v2/user` or up to three `/v2/teams/{id}`).
  Updates the token's "last active" time. Refresh tokens (`vcr_`) are never sent.

A rejected credential is never reported as a confirmed green: the provider
cannot tell us whether it is gone or just blocked here. GitHub and Vercel
rejections are green/inferred. A rejected **live** Stripe key stays amber,
because a valid key behind an IP or network policy can still move money.

</details>

<details>
<summary><b>Options and exit codes</b></summary>

<br>

| Flag | What it does |
| --- | --- |
| `-d, --dir <path>` | Directory to scan (default: current directory) |
| `-f, --file <name>` | Only read this file inside `--dir`, repeatable (default: every `.env*` file except `*.example`, `*.sample`, `*.template`) |
| `--offline` | Never call any API; report only what can be inferred from the credential format |
| `--json` | Machine-readable report |
| `--fail-on <red\|amber>` | Exit with code 1 if any credential is at least that level (for CI) |
| `--no-color` | Plain output (`NO_COLOR` is honoured too) |

Exit codes: `0` ok, `1` `--fail-on` threshold reached, `2` usage error, `70` internal error.

Use `-f`/`--file` to pick files. Don't pass `--env-file`, `--env-file-if-exists`, `--experimental-config-file` or `--experimental-default-config-file`: those are Node.js options, so Node reads that file itself before blastradius starts. blastradius exits with code 2 if it sees them. See [Quick start](#quick-start) for shebang and install notes.

`.env` files that are not regular files, larger than 1 MiB, or symlinks resolving outside `--dir` are skipped with a note on stderr. On Linux this check is race-free; on macOS and Windows it resolves paths by name, so a process that can write to the scanned directory during a scan can only be narrowed, not fully excluded.

</details>

<details>
<summary><b>Development</b></summary>

<br>

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build && npm run test:bin
npm run fixtures
node dist/cli.js --dir .fixtures/basic --offline
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

</details>

## License

[MIT](LICENSE) © 2026 Aitor Aguilar
