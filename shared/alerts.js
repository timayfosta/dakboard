/* Severe weather alerts via National Weather Service (US) */
(function () {
  function matchesKeywords(eventName, keywords) {
    const name = String(eventName || "").toLowerCase();
    return (keywords || []).some((k) => name.includes(String(k).toLowerCase()));
  }

  function severityRank(sev) {
    const map = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
    return map[sev] || 0;
  }

  async function fetchAlerts(cfg) {
    const { latitude, longitude, alertKeywords } = cfg.weather || {};
    if (latitude == null || longitude == null) return [];

    const url = `https://api.weather.gov/alerts/active?point=${latitude},${longitude}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/geo+json",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];

    return features
      .map((f) => {
        const p = f.properties || {};
        return {
          id: f.id || p.id,
          event: p.event || "Weather Alert",
          headline: p.headline || p.event || "Weather alert",
          severity: p.severity || "Unknown",
          urgency: p.urgency || "",
          description: p.description || "",
          ends: p.ends || p.expires || null,
        };
      })
      .filter((a) => matchesKeywords(a.event, alertKeywords))
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }

  window.FamilyAlerts = { fetchAlerts };
})();
