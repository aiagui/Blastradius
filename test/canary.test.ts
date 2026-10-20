/**
 * CANARY: runs the whole CLI against fixtures full of fake, greppable secrets
 * and fails if any canary marker reaches stdout, stderr or the JSON report,
 * or if a secret is sent to a host it is not bound to.
 */
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, main } from "../src/cli.js";
import { connectors } from "../src/connectors/index.js";
import { fixtureDir, mockFetch, type RecordedCall } from "./helpers.js";
import { stripeKey } from "../scripts/make-fixture.mjs";

const CANARY_DIR = fixtureDir("canary");
const STRIPE_CANARY = stripeKey("sk", "live", "CANARYSTRIPE0000000000000001");
const MARKER = "CANARY";

interface Run {
  code: number;
  out: string;
  err: string;
  calls: RecordedCall[];
}

let consoleOut = "";

beforeEach(() => {
  consoleOut = "";
  // Anything a connector or core module logs directly also counts as output.
  for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleOut += args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" ");
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function run(args: string[], status = 200, body: unknown = { echo: "ok" }): Promise<Run> {
  const calls = mockFetch(() => ({ status, body }));
  let out = "";
  let err = "";
  const code = await main(["--dir", CANARY_DIR, ...args], {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd: process.cwd(),
    isTTY: true,
    env: {},
  });
  return { code, out, err, calls };
}

function expectNoCanary(r: Run): void {
  expect(r.out).not.toContain(MARKER);
  expect(r.err).not.toContain(MARKER);
  expect(consoleOut).not.toContain(MARKER);
}

function expectSecretsOnlyToAllowedHosts(r: Run): void {
  const hosts = new Set(connectors.flatMap((c) => c.allowlist.rules.map((rule) => rule.host)));
  for (const call of r.calls) {
    const host = new URL(call.url).hostname;
    expect(hosts.has(host)).toBe(true);
    expect(call.url).not.toContain(MARKER);
    expect(call.body ?? "").not.toContain(MARKER);
  }
}

describe("canary: secrets never leave through output", () => {
  it.each([
    ["terminal", []],
    ["terminal offline", ["--offline"]],
    ["json", ["--json"]],
    ["json offline", ["--json", "--offline"]],
    ["no color", ["--no-color"]],
  ])("%s", async (_name, args) => {
    const r = await run(args);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.length).toBeGreaterThan(0);
    expectNoCanary(r);
    expectSecretsOnlyToAllowedHosts(r);
  });

  it("finds the canary credentials (the test is not vacuous)", async () => {
    const r = await run(["--json", "--offline"]);
    const report = JSON.parse(r.out) as { results: { envKey: string; source: string }[] };
    expect(report.results.length).toBeGreaterThanOrEqual(2);
    expect(report.results.map((x) => x.source)).toContain(".env.local");
  });

  it("stays clean when providers answer with errors or echo the token", async () => {
    for (const status of [401, 403, 404, 500]) {
      const r = await run(["--json"], status, { message: "bad credentials" });
      expectNoCanary(r);
    }
    // A malicious or buggy provider echoing the token back must not get it printed.
    const echo = await run(["--json"], 200, { token: STRIPE_CANARY, github: "ghp_CANARYGITHUB000000000000000000000001" });
    expectNoCanary(echo);
  });

  it("stays clean when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error(`${STRIPE_CANARY} ECONNREFUSED`))));
    let out = "";
    let err = "";
    const code = await main(["--dir", CANARY_DIR], { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd: "/", isTTY: false, env: {} });
    expect(code).toBe(EXIT.ok);
    expect(out + err + consoleOut).not.toContain(MARKER);
  });

  it("the output guard blocks a leak instead of printing it", async () => {
    const { guardOutput } = await import("../src/report/guard.js");
    const { Secret } = await import("../src/secret.js");
    const s = new Secret({ connector: "x", envKey: "K", source: ".env", value: "ex_live_CANARYGUARD0001", allowedHosts: ["a.test"] });
    const g = guardOutput(`oops ${s.reveal()} and "${s.reveal()}"`, [s]);
    expect(g.leaked).toBe(true);
    expect(g.text).not.toContain(MARKER);
  });
});
