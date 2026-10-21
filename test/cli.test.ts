import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, main } from "../src/cli.js";
import { meetsThreshold, rollUp, summarize } from "../src/risk/aggregate.js";
import { VERSION } from "../src/version.js";
import { fixtureDir, mockFetch } from "./helpers.js";

const BASIC = fixtureDir("basic");

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

  it.each([
    ["--env-file", ".env"],
    ["--env-file=.env"],
    ["--env-file-if-exists", ".env"],
    ["--env-file-if-exists=.env"],
    ["--offline", "--env-file", ".env"],
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
