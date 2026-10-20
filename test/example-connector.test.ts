import { afterEach, describe, expect, it, vi } from "vitest";
import { example } from "../src/connectors/example.js";
import { parseEnv } from "../src/env/parse.js";
import { createSafeFetch } from "../src/net/safeFetch.js";
import { mockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const env = parseEnv("EXAMPLE_API_KEY=ex_live_ABCDEFGH1234\nOTHER=ex_live_ABCDEFGH9999\nEXAMPLE_API_KEY=nope", ".env");
const ctx = (offline: boolean) => ({ fetch: createSafeFetch(example.allowlist), offline });

describe("example connector", () => {
  it("detects only matching keys and values", () => {
    const found = example.detect(env);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("live key");
  });

  it("dedupes the same value across files", () => {
    const twice = [...parseEnv("EXAMPLE_API_KEY=ex_test_ABCDEFGH1234", ".env"), ...parseEnv("EXAMPLE_API_KEY=ex_test_ABCDEFGH1234", ".env.local")];
    const found = example.detect(twice);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe(".env, .env.local");
  });

  it("offline: infers from the prefix without calling the network", async () => {
    const calls = mockFetch();
    const [f] = await example.check(example.detect(env)[0]!, ctx(true));
    expect(f).toMatchObject({ level: "red", confidence: "inferred" });
    expect(calls).toHaveLength(0);
  });

  it("confirms on 200 and reports green on 401", async () => {
    mockFetch(() => ({ status: 200 }));
    expect((await example.check(example.detect(env)[0]!, ctx(false)))[0]).toMatchObject({ level: "red", confidence: "confirmed" });
    mockFetch(() => ({ status: 401 }));
    expect((await example.check(example.detect(env)[0]!, ctx(false)))[0]).toMatchObject({ level: "green", confidence: "confirmed" });
  });

  it("is unknown on 403 or network failure", async () => {
    mockFetch(() => ({ status: 403 }));
    expect((await example.check(example.detect(env)[0]!, ctx(false)))[0]!.confidence).toBe("unknown");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("x"))));
    expect((await example.check(example.detect(env)[0]!, ctx(false)))[0]!.confidence).toBe("unknown");
  });
});
