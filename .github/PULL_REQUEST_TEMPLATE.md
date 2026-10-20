## What and why

<!-- One or two sentences. Link the issue: Closes #123 -->

## Checklist

<!-- CI runs the first four on every push. -->

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes (no direct network APIs outside `safeFetch`).
- [ ] `npm test` passes, including the secret canary test.
- [ ] Canary run is clean: `npm run fixtures && node dist/cli.js --dir .fixtures/canary --offline --no-color` prints no `CANARY`.
- [ ] Read-only: any new `safeFetch` allowlist rule is listed below and cannot mutate anything.
- [ ] I ran it for real: `npm run build` and `node dist/cli.js` against fixtures (or a test account).
- [ ] New or changed behaviour has tests; network is mocked in tests.
- [ ] No real credentials anywhere in the diff, fixtures, screenshots or recordings.
- [ ] `CHANGELOG.md` updated under `Unreleased` (if user-visible).
- [ ] Everything in this PR is written in English.

### New allowlist rules (if any)

<!-- e.g. GET api.github.com /user -->

Merging needs passing CI and one approving review. See CONTRIBUTING.md.
