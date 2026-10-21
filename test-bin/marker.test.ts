import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Marker regression: the installed bin must not let Node load a scanned
 * .env (or config file) before blastradius starts.
 *
 * Packs the already-built dist/ with `npm pack --ignore-scripts` and installs
 * the tarball into a temp prefix (a copy, not a symlink to the clone).
 * NODE_OPTIONS is left alone in the child environment.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_SRC = join(ROOT, "dist", "cli.js");

let prefix: string;
let bin: string;
let project: string;
let marker: string;

beforeAll(() => {
  if (!existsSync(CLI_SRC)) throw new Error("dist/cli.js missing: run npm run build first");

  const packDir = mkdtempSync(join(tmpdir(), "br-pack-"));
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const lines = pack.stdout.trim().split("\n").filter(Boolean);
  const tgzName = lines[lines.length - 1];
  if (tgzName === undefined) throw new Error("npm pack produced no tarball name");
  const tgz = join(packDir, tgzName);

  prefix = mkdtempSync(join(tmpdir(), "br-prefix-"));
  const install = spawnSync("npm", ["install", "-g", "--prefix", prefix, tgz], {
    encoding: "utf8",
    env: process.env,
  });
  if (install.status !== 0) {
    throw new Error(`npm install failed: ${install.stderr}\n${install.stdout}`);
  }
  bin = join(prefix, "bin", "blastradius");
  if (!existsSync(bin)) throw new Error(`installed bin missing at ${bin}`);
  // Sanity: the bin must start at all (BusyBox would fail here with 127).
  const ver = spawnSync(bin, ["--version"], { encoding: "utf8", env: process.env });
  if (ver.status !== 0) throw new Error(`installed bin --version failed: ${ver.stderr}`);

  project = mkdtempSync(join(tmpdir(), "br-project-"));
  marker = join(project, "MARKER");
  writeFileSync(join(project, "marker.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  writeFileSync(join(project, ".env"), "NODE_OPTIONS=--require ./marker.cjs\nAPP=1\n");
  writeFileSync(
    join(project, "evil.config.json"),
    JSON.stringify({ nodeOptions: { require: "./marker.cjs" } }) + "\n",
  );
  writeFileSync(join(project, "node.config.json"), JSON.stringify({ nodeOptions: { require: "./marker.cjs" } }) + "\n");
}, 120_000);

afterAll(() => {
  rmSync(prefix, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function run(args: string[]): { code: number | null; markers: number; err: string } {
  rmSync(marker, { force: true });
  const r = spawnSync(bin, args, { cwd: project, encoding: "utf8", env: process.env });
  return { code: r.status, markers: existsSync(marker) ? 1 : 0, err: r.stderr };
}

describe("installed package (packed install): Node must not preload scanned files", () => {
  it("--file does not load NODE_OPTIONS from the scanned .env", () => {
    const r = run(["--file", ".env", "--offline", "--no-color"]);
    expect(r.code).toBe(0);
    expect(r.markers).toBe(0);
  });

  it.each([
    ["--env-file", ".env"],
    ["--env-file=.env"],
    ["--env-file-if-exists", ".env"],
    ["--env-file-if-exists=.env"],
  ])("%s is rejected and does not run a NODE_OPTIONS payload", (...args: string[]) => {
    const r = run(args);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(0);
    expect(r.err).toContain("is a Node.js option");
  });

  // Known Node limitation: config-file flags still load after `--`.
  // Assert the actual observed behaviour so a dead bin (exit 127) fails the test.
  it("--experimental-config-file= still runs a config payload (known Node limitation)", () => {
    const r = run(["--experimental-config-file=evil.config.json"]);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(1);
  });

  it("--experimental-default-config-file still runs a config payload (known Node limitation)", () => {
    const r = run(["--experimental-default-config-file"]);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(1);
  });
});
