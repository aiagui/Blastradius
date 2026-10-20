// Writes the fake-credential fixtures used by the tests and the CI smoke steps.
//
// They are generated instead of committed: the Stripe values have the real
// live-key format (the connector needs it), and committing literals in that
// format trips secret scanners even though they are fake. The prefixes are
// assembled at runtime so no file in the repository contains one.
//
// Usage: node scripts/make-fixture.mjs <canary|basic> <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds a fake Stripe-style key, e.g. stripeKey("sk", "live", "CANARY...").
 * @param {"sk" | "rk" | "pk"} kind
 * @param {"live" | "test"} mode
 * @param {string} body
 * @returns {string}
 */
export function stripeKey(kind, mode, body) {
  return [kind, mode, body].join("_");
}

/** @type {Readonly<Record<string, () => Record<string, string>>>} */
const FIXTURES = {
  // Every connector has at least one canary credential; every value contains CANARY.
  canary: () => ({
    ".env": [
      "# Canary fixture. These are fake values designed to be easy to grep for.",
      "GITHUB_TOKEN=ghp_CANARYGITHUB000000000000000000000001",
      `STRIPE_SECRET_KEY=${stripeKey("sk", "live", "CANARYSTRIPE0000000000000001")}`,
      "VERCEL_TOKEN=CANARYVERCEL000000000001",
      `export QUOTED="${stripeKey("sk", "test", "CANARYQUOTED00000000000001")}"`,
      "GH_TOKEN=github_pat_CANARYGITHUBFG0000000001_000000000000000000000000000000000000000000000000000000001",
      "DEPLOY_KEY=vcp_CANARYVERCELPAT00000000000001",
      "",
    ].join("\n"),
    ".env.local": [
      "EXAMPLE_API_KEY='ex_test_CANARYLOCAL00001'",
      `STRIPE_RESTRICTED_KEY=${stripeKey("rk", "live", "CANARYSTRIPE0000000000000002")}`,
      `STRIPE_TEST_KEY=${stripeKey("sk", "test", "CANARYSTRIPE0000000000000003")}`,
      `STRIPE_RESTRICTED_TEST_KEY=${stripeKey("rk", "test", "CANARYSTRIPE0000000000000004")}`,
      `NEXT_PUBLIC_STRIPE_KEY=${stripeKey("pk", "live", "CANARYSTRIPE0000000000000005")}`,
      `NEXT_PUBLIC_STRIPE_TEST_KEY=${stripeKey("pk", "test", "CANARYSTRIPE0000000000000006")}`,
      "",
    ].join("\n"),
  }),
  // One fake live Stripe key, plus an .env.example the CLI must skip.
  basic: () => ({
    ".env": [
      "# Basic fixture: fake Stripe key (not a real credential)",
      `STRIPE_SECRET_KEY=${stripeKey("sk", "live", "FAKEFAKEFAKE1234567890")}`,
      "UNRELATED=hello",
      "",
    ].join("\n"),
    ".env.example": `STRIPE_SECRET_KEY=${stripeKey("sk", "live", "SHOULDBEIGNORED000000")}\n`,
  }),
};

/**
 * Writes fixture `kind` into `dir` (created if needed) and returns `dir`.
 * @param {string} kind
 * @param {string} dir
 * @returns {string}
 */
export function writeFixture(kind, dir) {
  const make = FIXTURES[kind];
  if (make === undefined) throw new Error(`make-fixture: unknown fixture "${kind}" (use canary or basic)`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(make())) writeFileSync(join(dir, name), content);
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [kind, dir] = process.argv.slice(2);
  if (kind === undefined || dir === undefined) {
    console.error("Usage: node scripts/make-fixture.mjs <canary|basic> <dir>");
    process.exitCode = 2;
  } else {
    writeFixture(kind, resolve(dir));
  }
}
