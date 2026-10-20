/**
 * Example connector: a template for real connectors. Copy this file to
 * src/connectors/<id>.ts (the file name is the connector id), rename the
 * export to `export const connector: Connector`, and add fixtures + tests under
 * test/connectors/<id>.test.ts. The registry is generated from that export.
 * This template itself is test-only and never registered.
 *
 * It targets a fictional provider. Its host uses the reserved `.invalid` TLD
 * (RFC 6761), so even a real run can never reach a real server.
 */
import { SafeFetchError } from "../net/safeFetch.js";
import type { Secret } from "../secret.js";
import { detectSecrets } from "./detect.js";
import type { CheckContext, Connector, Finding } from "./types.js";

const HOST = "api.example.invalid";

export const example: Connector = {
  id: "example",
  name: "Example",
  allowlist: {
    connector: "example",
    rules: [{ method: "GET", host: HOST, path: "/v1/me" }],
  },

  detect(env) {
    return detectSecrets(env, {
      connector: "example",
      keys: ["EXAMPLE_API_KEY"],
      valuePattern: /^ex_(live|test)_[A-Za-z0-9]{8,}$/,
      allowedHosts: [HOST],
      kind: (v) => (v.startsWith("ex_live_") ? "live key" : "test key"),
    });
  },

  async check(secret: Secret, ctx: CheckContext): Promise<Finding[]> {
    const live = secret.kind === "live key";
    const inferred: Finding = {
      level: live ? "red" : "amber",
      confidence: "inferred",
      message: live ? "Live key: can probably act on production data." : "Test key: limited to sandbox data.",
      advice: live ? "Move it to a secret manager and rotate it." : "Fine for local development; keep it out of git.",
      capabilities: { read: true, write: "unknown" },
    };
    if (ctx.offline) return [inferred];

    try {
      const res = await ctx.fetch({ method: "GET", url: `https://${HOST}/v1/me`, secret, discardBody: true });
      if (res.status === 401) {
        return [{ level: "green", confidence: "confirmed", message: "Key is revoked or invalid.", advice: "Remove it from your .env files." }];
      }
      if (res.ok) return [{ ...inferred, confidence: "confirmed" }];
      return [{ ...inferred, confidence: "unknown", message: `${inferred.message} (provider answered ${res.status})` }];
    } catch (err: unknown) {
      if (err instanceof SafeFetchError && (err.code === "network_error" || err.code === "timeout")) {
        return [{ ...inferred, confidence: "unknown", message: `${inferred.message} (could not reach ${HOST})` }];
      }
      throw err;
    }
  },
};
