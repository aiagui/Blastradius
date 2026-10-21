import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, main } from "../src/cli.js";
import { redactSecrets } from "../src/redact.js";
import { meetsThreshold, rollUp, summarize } from "../src/risk/aggregate.js";
import { VERSION } from "../src/version.js";
import { fixtureDir, mockFetch } from "./helpers.js";

const BASIC = fixtureDir("basic");
// Random-looking 24-char value (mixed case and digits, not all hex). Not a real token.
const RANDOM24 = "aB3dE5fG7hJ9kL1mN2pQ4rS6";

afterEach(() => vi.unstubAllGlobals());

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd: BASIC, isTTY: false, env: {} });
  return { code, out, err };
}

describe("cli", () => {
  it("version matches package.json", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect((await cli(["--version"])).out.trim()).toBe(VERSION);
  });

  it("prints help", async () => {
    expect((await cli(["--help"])).out).toContain("Usage: blastradius");
  });

  it("rejects bad arguments with exit 2", async () => {
    expect((await cli(["--nope"])).code).toBe(EXIT.usage);
    expect((await cli(["--fail-on", "green"])).code).toBe(EXIT.usage);
    expect((await cli(["--file", "../secrets/.env"])).code).toBe(EXIT.usage);
  });

  it("redacts token-shaped positionals from argument errors", async () => {
    const token = `ghp_${"Z".repeat(36)}`;
    const r = await cli([token]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("[REDACTED]");
    expect(r.err).not.toContain(token);
    expect(r.err).not.toContain("ghp_Z");
  });

  it("redacts unprefixed 24-char tokens from argument errors", async () => {
    const token = RANDOM24;
    const r = await cli([token]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("[REDACTED]");
    expect(r.err).not.toContain(token);
  });

  it("redacts token-shaped --dir and --file values in the report", async () => {
    const token = `ghp_${"Q".repeat(36)}`;
    const r = await cli(["--dir", token, "--offline", "--json"]);
    expect(r.out).not.toContain(token);
    expect(r.out).toContain("[REDACTED]");
    const vercel = RANDOM24;
    const r2 = await cli(["--file", vercel, "--offline", "--json"]);
    // missing file: still must not echo the name if token-shaped
    expect(r2.out).not.toContain(vercel);
  });


  it("does not redact ordinary 24-char names or ObjectIds, in text or JSON", async () => {
    expect(redactSecrets("-d PaymentReconciliationApp")).toBe("-d PaymentReconciliationApp");
    expect(redactSecrets("/data/64b7f0c2e4a1b2c3d4e5f607")).toBe("/data/64b7f0c2e4a1b2c3d4e5f607");
    expect(redactSecrets(".env.PaymentReconciliationApp")).toBe(".env.PaymentReconciliationApp");
    expect(redactSecrets(`x ${RANDOM24} y`)).toBe("x [REDACTED] y");

    const dir = mkdtempSync(join(tmpdir(), "br-names-"));
    const app = join(dir, "PaymentReconciliationApp");
    const oid = join(dir, "64b7f0c2e4a1b2c3d4e5f607");
    mkdirSync(app);
    mkdirSync(oid);
    writeFileSync(join(app, ".env.PaymentReconciliationApp"), "A=1\n");
    const r = await cli(["--dir", app, "--file", ".env.PaymentReconciliationApp", "--offline", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const report = JSON.parse(r.out) as { directory: string; files: string[] };
    expect(report.directory).toBe(app);
    expect(report.files).toEqual([".env.PaymentReconciliationApp"]);
    expect(r.out).not.toContain("[REDACTED]");
    const r2 = await cli(["--dir", oid, "--offline", "--json"]);
    expect((JSON.parse(r2.out) as { directory: string }).directory).toBe(oid);
  });

  it("redacts a random-looking 24-char token with no digits", () => {
    const noDigits = "qWeRtYuIoPaSdFgHjKlZxCvB"; // Not a real token.
    expect(noDigits).toHaveLength(24);
    expect(redactSecrets(`-d ${noDigits}`)).toBe("-d [REDACTED]");
    // CamelCase without digits and fewer than six capitals stays readable.
    expect(redactSecrets("BillingStatementsArchive")).toBe("BillingStatementsArchive");
  });

  it("redacts a random 24-char token after an underscore", () => {
    expect(redactSecrets(`x_${RANDOM24}`)).toBe("x_[REDACTED]");
    expect(redactSecrets(`dir/x_${RANDOM24}/y`)).not.toContain(RANDOM24);
  });

  it("does not echo any character of -v<token>", async () => {
    const r = await cli([`-v${RANDOM24}`]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).not.toContain("'-a'");
    expect(r.err).not.toContain(RANDOM24.slice(0, 3));
    expect(r.err).toContain("combined short-option group");
  });

  it("redacts the file name in the skipped warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "br-skip-"));
    const name = `.env.${RANDOM24}`;
    mkdirSync(join(dir, name)); // a directory, so it is skipped as not_regular
    const r = await cli(["--dir", dir, "--file", name, "--offline", "--json"]);
    expect(r.err).toContain("skipped .env.[REDACTED]: not a regular file");
    expect(r.err).not.toContain(RANDOM24);
    expect(r.out).not.toContain(RANDOM24);
  });

  it.each([
    ["--env-file", ".env"],
    ["--env-file=.env"],
    ["--env-file-if-exists", ".env"],
    ["--env-file-if-exists=.env"],
    ["--offline", "--env-file", ".env"],
    ["--experimental-config-file", "node.config.json"],
    ["--experimental-config-file=node.config.json"],
    ["--experimental-default-config-file"],
    ["--experimental-default-config-file=node.config.json"],
    ["--offline", "--experimental-config-file", "node.config.json"],
  ])("rejects Node's own file flags: %s", async (...args: string[]) => {
    const r = await cli(args);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("is a Node.js option");
    expect(r.err).toContain("-f/--file");
    expect(r.out).toBe("");
  });

  it("--file and -f select files inside --dir", async () => {
    const long = await cli(["--file", ".env", "--offline"]);
    expect(long.code).toBe(EXIT.ok);
    expect(long.out).toContain("Scanned: .env");
    const short = await cli(["-f", ".env", "--offline"]);
    expect(short.code).toBe(EXIT.ok);
    expect(short.out).toContain("Scanned: .env");
  });

  it("prints a terminal report and skips .env.example", async () => {
    const r = await cli(["--offline"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("RED");
    expect(r.out).toContain("STRIPE_SECRET_KEY");
    expect(r.out).toContain("Scanned: .env");
    expect(r.out).not.toContain(".env.example");
    expect(r.out.includes("\u001b[")).toBe(false);
  });

  it("--fail-on red exits 1 when a red credential is found", async () => {
    expect((await cli(["--offline", "--fail-on", "red"])).code).toBe(EXIT.threshold);
  });

  it("JSON report has a stable shape", async () => {
    mockFetch(() => ({ status: 200, body: {} }));
    const r = await cli(["--json"]);
    const report = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual(["tool", "version", "generatedAt", "directory", "files", "offline", "summary", "results"]);
    expect(report["summary"]).toMatchObject({ level: "red", total: 1 });
  });
});

describe("risk aggregation", () => {
  it("rolls up to the worst level with the weakest confidence at that level", () => {
    expect(
      rollUp([
        { level: "green", confidence: "confirmed", message: "a" },
        { level: "red", confidence: "confirmed", message: "b" },
        { level: "red", confidence: "inferred", message: "c" },
      ]),
    ).toEqual({ level: "red", confidence: "inferred" });
    expect(rollUp([])).toEqual({ level: "amber", confidence: "unknown" });
  });

  it("summarizes and applies thresholds", () => {
    expect(summarize([]).level).toBe("none");
    expect(meetsThreshold("amber", "red")).toBe(false);
    expect(meetsThreshold("red", "amber")).toBe(true);
    expect(meetsThreshold("none", "amber")).toBe(false);
  });
});
