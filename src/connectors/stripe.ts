/**
 * Stripe connector.
 *
 * Key types (https://docs.stripe.com/keys):
 *  - sk_live_ / sk_test_  secret keys: full API access for the account/mode.
 *  - rk_live_ / rk_test_  restricted keys: permissions set in the Dashboard.
 *    Stripe has no API that lists a restricted key's permissions, so we probe a
 *    few read endpoints with GET. Write permissions can never be learned
 *    without writing, so they are always reported as "unknown".
 *  - pk_live_ / pk_test_  publishable keys: meant to be public. Reported green
 *    without any network call.
 *  - whsec_               webhook signing secrets: offline only. Possession lets
 *    anyone forge webhooks for the endpoint.
 *
 * A 401 is ambiguous: the key may be revoked, rolled or expired, or the request
 * may be blocked by the key's access policy (IP/ASN/country rules). So a 401 is
 * never a confirmed green: live keys stay amber, test keys become green/inferred.
 * Unlike GitHub and Vercel (green/inferred on any rejection), a live Stripe key
 * stays amber because a valid key behind an access policy can still move real
 * money from an allowed network; a false green there is the worst outcome.
 *
 * Traces left on the provider side: every probe is a normal API request and
 * shows up in the account's Dashboard request logs (Developers > Logs).
 * Probe bodies are always discarded (`discardBody: true`) because list
 * endpoints return customer data.
 */
import { SafeFetchError } from "../net/safeFetch.js";
import type { Secret } from "../secret.js";
import { detectSecrets } from "./detect.js";
import type { Capability, CheckContext, Connector, Finding } from "./types.js";

const HOST = "api.stripe.com";

/** Read probes for restricted keys. GET only, bodies discarded. */
const PROBES = [
  { path: "/v1/balance", query: "", capability: "read_balance" },
  { path: "/v1/charges", query: "?limit=1", capability: "read_charges" },
  { path: "/v1/customers", query: "?limit=1", capability: "read_customers" },
] as const;

const TYPES = { sk: "secret", rk: "restricted", pk: "publishable" } as const;
type KeyType = (typeof TYPES)[keyof typeof TYPES];
type Mode = "live" | "test";

const KEY_PATTERN = /^(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}$/;
const WHSEC_PATTERN = /^whsec_[A-Za-z0-9_]{16,}$/;

interface KeyInfo {
  readonly type: KeyType;
  readonly mode: Mode;
}

/** Parses the key prefix of a raw value. Only used by `detect`. */
function keyInfo(value: string): KeyInfo | undefined {
  const m = KEY_PATTERN.exec(value);
  if (m === null) return undefined;
  const prefix = m[1];
  const mode = m[2];
  if ((prefix !== "sk" && prefix !== "rk" && prefix !== "pk") || (mode !== "live" && mode !== "test")) return undefined;
  return { type: TYPES[prefix], mode };
}

const kindLabel = (k: KeyInfo): string => `${k.type} ${k.mode} key`;

/** Every label `detect` can produce, mapped back to its KeyInfo (no re-parsing, no casts). */
const BY_LABEL: ReadonlyMap<string, KeyInfo> = new Map(
  Object.values(TYPES).flatMap((type) =>
    (["live", "test"] as const).map((mode): [string, KeyInfo] => [kindLabel({ type, mode }), { type, mode }]),
  ),
);

function rejected(mode: Mode): Finding {
  const message = "Stripe rejected this key (401): revoked, rolled, expired or blocked by an access policy.";
  const advice = "If it is still used in production, confirm in the Dashboard that it is revoked; otherwise roll it.";
  return mode === "live"
    ? { level: "amber", confidence: "unknown", message, advice }
    : { level: "green", confidence: "inferred", message, advice: "Remove it from your .env files." };
}

/** Value-free reason for a failed request. Non-SafeFetchErrors are rethrown. */
function failureReason(err: unknown): string {
  if (!(err instanceof SafeFetchError)) throw err;
  return err.code === "network_error" || err.code === "timeout" ? `could not reach ${HOST}` : "check blocked";
}

/** Any SafeFetchError keeps the format-based level, with unknown confidence. */
function fetchFailed(base: Finding, err: unknown): Finding {
  return { ...base, confidence: "unknown", message: `${base.message} (${failureReason(err)})` };
}

function secretKeyFinding(mode: Mode): Finding {
  return mode === "live"
    ? {
        level: "red",
        confidence: "inferred",
        message: "Live secret key: full access to real payments, refunds, payouts and customer data.",
        advice:
          "Replace it with a restricted key (rk_live_) that only has the permissions this project needs, then roll this key in the Dashboard.",
        capabilities: { read: true, write: true, move_money: true },
      }
    : {
        level: "amber",
        confidence: "inferred",
        message: "Test secret key: full access to test-mode data, no real money.",
        advice: "Fine for local development; keep it out of git and away from tools and scripts that do not need it.",
        capabilities: { read: true, write: true, move_money: false },
      };
}

async function checkSecretKey(secret: Secret, mode: Mode, ctx: CheckContext): Promise<Finding[]> {
  const inferred = secretKeyFinding(mode);
  if (ctx.offline) return [inferred];
  try {
    const res = await ctx.fetch({ method: "GET", url: `https://${HOST}/v1/balance`, secret, discardBody: true });
    if (res.status === 401) return [rejected(mode)];
    if (res.ok) return [{ ...inferred, confidence: "confirmed" }];
    return [{ ...inferred, confidence: "unknown", message: `${inferred.message} (Stripe answered ${res.status})` }];
  } catch (err: unknown) {
    return [fetchFailed(inferred, err)];
  }
}

const RESTRICTED_ADVICE =
  "Open the key in the Stripe Dashboard and check that it only has the permissions this project needs.";

async function checkRestrictedKey(secret: Secret, mode: Mode, ctx: CheckContext): Promise<Finding[]> {
  const live = mode === "live";
  const moveMoney: Capability = live ? "unknown" : false;
  const base: Finding = {
    level: "amber",
    confidence: "unknown",
    message: `Restricted ${mode} key: permissions are configured in the Stripe Dashboard and cannot be listed by API.`,
    advice: RESTRICTED_ADVICE,
    capabilities: { read: "unknown", write: "unknown", move_money: moveMoney },
  };
  if (ctx.offline) return [base];

  const caps: Record<string, Capability> = {};
  let anyRead = false;
  let anyUnclear = false;
  const reasons = new Set<string>();
  for (const probe of PROBES) {
    try {
      const res = await ctx.fetch({
        method: "GET",
        url: `https://${HOST}${probe.path}${probe.query}`,
        secret,
        discardBody: true,
      });
      if (res.status === 401 && !anyRead) return [rejected(mode)];
      if (res.ok) {
        caps[probe.capability] = true;
        anyRead = true;
      } else if (res.status === 403) {
        caps[probe.capability] = false;
      } else {
        caps[probe.capability] = "unknown";
        anyUnclear = true;
        reasons.add(`Stripe answered ${res.status}`);
      }
    } catch (err: unknown) {
      reasons.add(failureReason(err));
      caps[probe.capability] = "unknown";
      anyUnclear = true;
    }
  }

  const read: Capability = anyRead ? true : anyUnclear ? "unknown" : false;
  const capabilities = { read, ...caps, write: "unknown" as const, move_money: moveMoney };
  if (anyRead) {
    return [
      {
        level: live ? "red" : "amber",
        confidence: "confirmed",
        message: live
          ? "Restricted live key can read real payment or customer data. Write permissions are unknown."
          : "Restricted test key can read test-mode data. Write permissions are unknown.",
        advice: RESTRICTED_ADVICE,
        capabilities,
      },
    ];
  }
  return [
    {
      ...base,
      message: anyUnclear
        ? `${base.message} Some read probes failed (${[...reasons].join("; ")}).`
        : `${base.message} No read access found, but it may still be able to write.`,
      capabilities,
    },
  ];
}

export const stripe: Connector = {
  id: "stripe",
  name: "Stripe",
  allowlist: {
    connector: "stripe",
    rules: PROBES.map((p) => ({ method: "GET" as const, host: HOST, path: p.path })),
  },

  detect(env) {
    const keys = detectSecrets(env, {
      connector: "stripe",
      valuePattern: KEY_PATTERN,
      allowedHosts: [HOST],
      kind: (v) => {
        const k = keyInfo(v);
        return k === undefined ? undefined : kindLabel(k);
      },
    });
    const webhooks = detectSecrets(env, {
      connector: "stripe",
      valuePattern: WHSEC_PATTERN,
      allowedHosts: [HOST],
      kind: () => "webhook signing secret",
    });
    return [...keys, ...webhooks];
  },

  async check(secret: Secret, ctx: CheckContext): Promise<Finding[]> {
    if (secret.kind === "webhook signing secret") {
      return [
        {
          level: "amber",
          confidence: "inferred",
          message: "Webhook signing secret: anyone with this value can forge webhooks for the endpoint.",
          advice: "Roll this signing secret in your provider dashboard and store the new value in a secrets vault.",
          capabilities: { read: false, write: false, move_money: false, forge_webhooks: true },
        },
      ];
    }
    // Secret values are only revealed by safeFetch; the kind label carries the key type.
    const k = secret.kind === undefined ? undefined : BY_LABEL.get(secret.kind);
    if (k === undefined) {
      return [{ level: "amber", confidence: "unknown", message: "Unrecognised Stripe key format." }];
    }
    switch (k.type) {
      case "publishable":
        return [
          {
            level: "green",
            confidence: "inferred",
            message: "Publishable key: designed to be public, cannot read or change account data.",
            capabilities: { read: false, write: false, move_money: false },
          },
        ];
      case "secret":
        return checkSecretKey(secret, k.mode, ctx);
      case "restricted":
        return checkRestrictedKey(secret, k.mode, ctx);
    }
  },
};

/** Registry entry, picked up by scripts/gen-connectors.mjs. */
export const connector: Connector = stripe;
