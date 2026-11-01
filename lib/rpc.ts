// Minimal Bitcoin-style JSON-RPC client for the eCash (ECX) mainchain node.
// Server-side only (reads credentials from env; talks to a localhost node).
//
// Configuration is read LAZILY, on each call, rather than captured at module
// load. This matters for the standalone indexer: it calls process.loadEnvFile()
// in its own top-level body, which runs AFTER this module is imported. If we
// snapshotted env at import time we'd bake in the fallback values before
// .env.local was loaded and silently hit the wrong endpoint. Reading per call
// makes import order irrelevant.
//
// Defaults match a stock eCash mainnet node (`bitcoind` from the
// L1-ecash-bitcoin release: mainnet JSON-RPC listens on 8532, P2P on 8533).
// Override via env:
//   ECASH_RPC_URL         (default http://127.0.0.1:8532)
//   ECASH_RPC_USER        (default "user")
//   ECASH_RPC_PASS        (default "password")
//   ECASH_RPC_TIMEOUT_MS  (default 30000)

const DEFAULT_URL = "http://127.0.0.1:8532";
const DEFAULT_USER = "user";
const DEFAULT_PASS = "password";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RpcConfig {
  url: string;
  user: string;
  pass: string;
  /** True when BOTH credentials are unset and the placeholder defaults are in use. */
  usingDefaultCredentials: boolean;
}

/** Read + validate RPC configuration from the current environment. */
export function getRpcConfig(): RpcConfig {
  const url = process.env.ECASH_RPC_URL ?? DEFAULT_URL;
  const user = process.env.ECASH_RPC_USER ?? DEFAULT_USER;
  const pass = process.env.ECASH_RPC_PASS ?? DEFAULT_PASS;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Note: never interpolate credentials into errors.
    throw new Error(
      `Invalid ECASH_RPC_URL: ${JSON.stringify(url)} is not a valid URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid ECASH_RPC_URL: expected an http(s) URL, got protocol "${parsed.protocol}".`,
    );
  }

  const usingDefaultCredentials =
    process.env.ECASH_RPC_USER == null &&
    process.env.ECASH_RPC_PASS == null &&
    user === DEFAULT_USER &&
    pass === DEFAULT_PASS;

  return { url, user, pass, usingDefaultCredentials };
}

function authHeaderFor(cfg: RpcConfig): string {
  return "Basic " + Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
}

/** Protocol + host only (never userinfo/credentials), for safe error messages. */
function safeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "the configured RPC endpoint";
  }
}

export async function rpc<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const cfg = getRpcConfig();
  const timeoutMs = Number(
    process.env.ECASH_RPC_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "text/plain;",
        authorization: authHeaderFor(cfg),
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "ecash-meter", method, params }),
      // Never cache at the fetch layer; the data layer handles TTL caching.
      cache: "no-store",
      // A stalled node must not hang the indexer forever.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Sanitize: report method + host + reason only. Never the auth header,
    // credentials, or the request body.
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : "connection failed";
    throw new Error(
      `RPC ${method} to ${safeEndpoint(cfg.url)} ${reason}. Is the node reachable?`,
    );
  }
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { result: T; error: unknown };
  if (json.error) {
    throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

/**
 * Run async work over `items` with bounded concurrency, preserving order.
 * Keeps request-time block scans fast without opening thousands of sockets.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
