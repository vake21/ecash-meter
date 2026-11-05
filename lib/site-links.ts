import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Deployment-specific presentation: the footer's further-reading links and the
// "project of X" credit. Deliberately NOT in the repository — this ships as code
// only, so a fork renders a clean tracker with no external links and no credit
// pointing at somebody else's site.
//
// To populate them, copy site.local.example.json to site.local.json (gitignored)
// and edit. Read once at startup, so restart the server after changing it.

export interface LearnLink {
  label: string;
  href: string;
}

export interface SiteCredit {
  label: string;
  href: string;
  /** Optional badge, a filename inside public/. Omitted → text-only credit. */
  logo?: string;
}

interface SiteLocal {
  learnLinks?: LearnLink[];
  credit?: SiteCredit;
  /**
   * Base URL of an ECX block explorer (mempool.space-style paths). When set,
   * the activity feed links blocks to `<explorer>/block/<hash>` and
   * transactions to `<explorer>/tx/<txid>`; when absent, it shows plain text.
   */
  explorer?: string;
}

const CONFIG_FILE = join(process.cwd(), "site.local.json");

/** Only http(s) is allowed — config is a file on disk, but a stray `javascript:`
 *  href would still become a live XSS vector in the rendered page. */
function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

function load(): SiteLocal {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as SiteLocal;
  } catch (err) {
    // A malformed config must not take the site down — fall back to unbranded.
    console.error(
      "[ecash-meter] site.local.json could not be parsed, ignoring it:",
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

const cfg = load();

export const learnLinks: LearnLink[] = (cfg.learnLinks ?? []).flatMap((l) => {
  const href = safeHref(l?.href);
  return href && typeof l?.label === "string" ? [{ label: l.label, href }] : [];
});

export const credit: (SiteCredit & { hasLogo: boolean }) | null = (() => {
  const c = cfg.credit;
  const href = safeHref(c?.href);
  if (!c || !href || typeof c.label !== "string") return null;
  const hasLogo =
    typeof c.logo === "string" &&
    c.logo.length > 0 &&
    !c.logo.includes("/") && // keep it to a bare filename inside public/
    existsSync(join(process.cwd(), "public", c.logo));
  return { ...c, href, hasLogo };
})();

/** Explorer base URL for activity-feed links (no trailing slash), or null. */
export const explorerUrl: string | null = (() => {
  const href = safeHref(cfg.explorer);
  return href ? href.replace(/\/+$/, "") : null;
})();
