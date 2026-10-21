import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the built CLI as a real process, the way npm installs it on Unix:
// a symlink to dist/cli.js, started through its `#!/usr/bin/env node` line.
// Run with `npm run test:bin` after `npm run build`.

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let root: string;
let bin: string;
let project: string;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run `npm run build` first");
  root = mkdtempSync(join(tmpdir(), "blastradius-bin-"));
  mkdirSync(join(root, "bin"));
  bin = join(root, "bin", "blastradius");
  symlinkSync(CLI, bin);
  project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "APP_NAME=demo\n");
  writeFileSync(join(project, ".env.production"), "APP_NAME=demo\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[], cwd: string): { code: number | null; out: string; err: string } {
  const env = { ...process.env };
  delete env["NODE_OPTIONS"];
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("installed bin", () => {
  it("--file reads the named file", () => {
    const r = run(["--file", ".env", "--offline", "--no-color"], project);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Scanned: .env");
  });

  it("-f reads the named file", () => {
    const r = run(["-f", ".env.production", "--offline", "--no-color"], project);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Scanned: .env.production");
  });

  it("--dir X --file Y works from another directory", () => {
    const r = run(["--dir", project, "--file", ".env.production", "--offline", "--no-color"], root);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Scanned: .env.production");
  });

  it.each([
    ["--env-file", ".env.production"],
    ["--env-file=.env.production"],
    ["--env-file-if-exists", ".env.production"],
    ["--env-file-if-exists=.env.production"],
  ])("rejects Node's own flag: %s", (...args: string[]) => {
    const r = run([...args, "--offline"], project);
    expect(r.code).toBe(2);
    expect(r.err).toContain("is a Node.js option");
    expect(r.err).toContain("--file");
    expect(r.out).toBe("");
  });
});
