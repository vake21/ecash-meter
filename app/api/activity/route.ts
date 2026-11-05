import { getRecentActivity, DEFAULT_ACTIVITY_LIMIT } from "@/lib/activity";
import { isDemoMode } from "@/lib/dashboard";

// Never cache: the feed polls this to pick up newly indexed blocks.
export const dynamic = "force-dynamic";

/**
 * Recent drivechain activity (BMM blocks, deposits, withdrawals), newest first,
 * for the live feed on the page. DB-only, like the page: it never contacts the
 * node, so it is exactly as fresh as the indexer's last run.
 *
 *   GET /api/activity?limit=25   (1–100)
 *
 * 503 with a reason code when the store is unavailable (same checks and codes
 * as /api/health; no paths or error text), or in demo mode, where there is no
 * real activity to show.
 */
export async function GET(request?: Request) {
  if (isDemoMode()) {
    return Response.json({ status: "demo", events: [] }, { status: 503 });
  }
  const limitParam = request ? new URL(request.url).searchParams.get("limit") : null;
  const r = getRecentActivity(limitParam ? Number(limitParam) : DEFAULT_ACTIVITY_LIMIT);
  if (!r.ok) {
    return Response.json({ status: r.reason, events: [] }, { status: 503 });
  }
  return Response.json(
    { status: "ok", tipHeight: r.tipHeight, events: r.events },
    { headers: { "Cache-Control": "no-store" } },
  );
}
