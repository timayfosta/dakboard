/**
 * Cloudflare Worker: private Google Calendar feed (no public calendar needed)
 *
 * Setup:
 * 1. Google Calendar → Settings → your calendar → Integrate calendar
 *    → copy "Secret address in iCal format"
 * 2. wrangler secret put ICS_URL   (paste that secret iCal URL)
 * 3. Deploy this worker, then set googleCalendar.proxyUrl in shared/config.js
 *    to the worker URL.
 *
 * The secret iCal URL is NOT the same as making the calendar public.
 * Only people/services with that long private URL can read events.
 */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (!env.ICS_URL) {
      return json({ error: "ICS_URL secret not configured" }, 500);
    }

    try {
      const upstream = await fetch(env.ICS_URL, {
        headers: { "User-Agent": "family-board-calendar-worker" },
      });
      if (!upstream.ok) {
        return json({ error: `Upstream ICS HTTP ${upstream.status}` }, 502);
      }

      const text = await upstream.text();
      return new Response(text, {
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
