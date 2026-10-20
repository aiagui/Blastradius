import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";
import { writeFixture } from "../scripts/make-fixture.mjs";

/**
 * Writes a generated fake-credential fixture (see scripts/make-fixture.mjs)
 * into a fresh temp dir, removed after the test file. Returns the dir.
 */
export function fixtureDir(kind: "canary" | "basic"): string {
  const dir = writeFixture(kind, mkdtempSync(join(tmpdir(), `blastradius-${kind}-`)));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** Replaces global fetch with a stub. Real network is never touched in tests. */
export function mockFetch(
  respond: (call: RecordedCall) => { status: number; body?: unknown; headers?: Record<string, string> } = () => ({
    status: 200,
    body: {},
  }),
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: URL | string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      const r = respond(call);
      const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return Promise.resolve(new Response(text, { status: r.status, headers: r.headers ?? {} }));
    }),
  );
  return calls;
}
