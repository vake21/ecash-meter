// Fix #2 — lazy, validated, credential-safe, timeout-guarded RPC config.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rpc, getRpcConfig } from "../lib/rpc";

const ENV_KEYS = [
  "ECASH_RPC_URL",
  "ECASH_RPC_USER",
  "ECASH_RPC_PASS",
  "ECASH_RPC_TIMEOUT_MS",
] as const;

const realFetch = globalThis.fetch;

function snapshotEnv() {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k]!;
  }
}
const baseEnv = snapshotEnv();

afterEach(() => {
  restoreEnv(baseEnv);
  globalThis.fetch = realFetch;
});

/** Mock fetch that records the request and returns a JSON-RPC success. */
function mockFetchOk() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, opts: RequestInit) => {
    calls.push({ url: String(url), headers: opts.headers as Record<string, string> });
    return { ok: true, json: async () => ({ result: "OK", error: null }) } as Response;
  }) as typeof fetch;
  return calls;
}

test("rpc() uses the configured URL from the environment", async () => {
  process.env.ECASH_RPC_URL = "http://127.0.0.1:19999";
  const calls = mockFetchOk();
  await rpc("getblockcount");
  assert.equal(calls[0].url, "http://127.0.0.1:19999");
});

test("config is read lazily — env set AFTER import still applies", async () => {
  // (This module imported rpc at top; setting env here, at call time, must win.)
  process.env.ECASH_RPC_URL = "http://127.0.0.1:28888";
  const calls = mockFetchOk();
  await rpc("getblockcount");
  assert.equal(calls[0].url, "http://127.0.0.1:28888");
});

test("defaults are used only when the variables are absent", () => {
  for (const k of ENV_KEYS) delete process.env[k];
  const cfg = getRpcConfig();
  assert.equal(cfg.url, "http://127.0.0.1:8532");
  assert.equal(cfg.user, "user");
  assert.equal(cfg.pass, "password");
  assert.equal(cfg.usingDefaultCredentials, true);
});

test("Authorization header is Basic base64(user:pass) from config", async () => {
  process.env.ECASH_RPC_USER = "alice";
  process.env.ECASH_RPC_PASS = "s3cret";
  const calls = mockFetchOk();
  await rpc("getblockcount");
  const auth = calls[0].headers["authorization"];
  const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
  assert.equal(decoded, "alice:s3cret");
  // And this configuration is NOT flagged as default credentials.
  assert.equal(getRpcConfig().usingDefaultCredentials, false);
});

test("connection errors never leak the password or Authorization header", async () => {
  process.env.ECASH_RPC_USER = "alice";
  process.env.ECASH_RPC_PASS = "super-secret-pw";
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED super-secret-pw Basic QWxpY2U="); // hostile error text
  }) as typeof fetch;
  await assert.rejects(rpc("getblockcount"), (err: Error) => {
    assert.doesNotMatch(err.message, /super-secret-pw/);
    assert.doesNotMatch(err.message, /Basic /);
    assert.match(err.message, /connection failed/);
    return true;
  });
});

test("an invalid RPC URL produces a clear configuration error", () => {
  process.env.ECASH_RPC_URL = "not a url";
  assert.throws(() => getRpcConfig(), /Invalid ECASH_RPC_URL/);
});

test("a non-http(s) URL is rejected", () => {
  process.env.ECASH_RPC_URL = "ftp://127.0.0.1:21";
  assert.throws(() => getRpcConfig(), /expected an http\(s\) URL/);
});

test("a stalled request times out via AbortSignal", async () => {
  process.env.ECASH_RPC_URL = "http://127.0.0.1:8532";
  process.env.ECASH_RPC_TIMEOUT_MS = "25";
  // Mock fetch that never resolves on its own — only the abort signal ends it.
  globalThis.fetch = ((_url: string, opts: RequestInit) =>
    new Promise((_, reject) => {
      opts.signal!.addEventListener("abort", () =>
        reject((opts.signal as AbortSignal).reason),
      );
    })) as typeof fetch;
  await assert.rejects(rpc("getblockcount"), /timed out after 25ms/);
});
