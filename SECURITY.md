# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report vulnerabilities privately through
GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/aiagui/blastradius/security/advisories/new)
("Report a vulnerability" in the Security tab). The maintainer enables private
vulnerability reporting when the repository is public. We aim to reply within
7 days.

Especially relevant reports:

- any way a secret value can reach output, logs, files or a host other than its issuer;
- any way to make `blastradius` perform a non-read-only request;
- any way a crafted `.env` file or API response changes what is executed or requested.

## Scope of the tool

`blastradius` sends each credential only to the service that issued it, using
read-only requests from an allowlist. These requests may appear in the
provider's logs (for example Stripe Dashboard request logs or GitHub audit logs).

Never include real credentials in issues, PRs or test fixtures.
