/* WMO weather codes → weather.com-style SVG icons (Open-Meteo) */
(function () {
  const LABELS = {
    clear: "Clear",
    mostlyClear: "Mostly clear",
    partlyCloudy: "Partly cloudy",
    overcast: "Cloudy",
    fog: "Fog",
    drizzle: "Drizzle",
    rain: "Rain",
    heavyRain: "Heavy rain",
    snow: "Snow",
    heavySnow: "Heavy snow",
    showers: "Showers",
    heavyShowers: "Heavy showers",
    thunder: "Thunderstorm",
    hail: "Storm + hail",
    severe: "Severe storm",
  };

  function typeForCode(code) {
    const map = {
      0: "clear",
      1: "mostlyClear",
      2: "partlyCloudy",
      3: "overcast",
      45: "fog",
      48: "fog",
      51: "drizzle",
      53: "drizzle",
      55: "drizzle",
      56: "drizzle",
      57: "drizzle",
      61: "rain",
      63: "rain",
      65: "heavyRain",
      66: "rain",
      67: "heavyRain",
      71: "snow",
      73: "snow",
      75: "heavySnow",
      77: "snow",
      80: "showers",
      81: "showers",
      82: "heavyShowers",
      85: "snow",
      86: "heavySnow",
      95: "thunder",
      96: "hail",
      99: "severe",
    };
    return map[code] || "partlyCloudy";
  }

  function sun(cx, cy, r) {
    const rays = [];
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * (r + 3);
      const y1 = cy + Math.sin(a) * (r + 3);
      const x2 = cx + Math.cos(a) * (r + 9);
      const y2 = cy + Math.sin(a) * (r + 9);
      rays.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f5c84c" stroke-width="3" stroke-linecap="round"/>`);
    }
    return `${rays.join("")}<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f5c84c"/>`;
  }

  function cloud(x, y, scale, fill) {
    const s = scale || 1;
    return `
      <g transform="translate(${x} ${y}) scale(${s})">
        <ellipse cx="18" cy="22" rx="14" ry="11" fill="${fill}"/>
        <ellipse cx="32" cy="18" rx="16" ry="13" fill="${fill}"/>
        <ellipse cx="46" cy="22" rx="13" ry="10" fill="${fill}"/>
        <rect x="10" y="20" width="44" height="12" fill="${fill}"/>
      </g>`;
  }

  function svgShell(inner) {
    return `<svg class="wx-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">${inner}</svg>`;
  }

  const SVG = {
    clear: () => svgShell(`${sun(32, 32, 13)}`),

    mostlyClear: () => svgShell(`${sun(22, 22, 10)}${cloud(18, 28, 0.85, "#b8c2d0")}`),

    partlyCloudy: () => svgShell(`${sun(24, 18, 9)}${cloud(14, 26, 1, "#b8c2d0")}`),

    overcast: () => svgShell(`${cloud(8, 18, 1.05, "#9aa3b2")}${cloud(12, 30, 0.95, "#b8c2d0")}`),

    fog: () =>
      svgShell(`
        ${cloud(8, 16, 1, "#9aa3b2")}
        <line x1="14" y1="44" x2="50" y2="44" stroke="#9aa3b2" stroke-width="3" stroke-linecap="round"/>
        <line x1="10" y1="50" x2="46" y2="50" stroke="#b8c2d0" stroke-width="3" stroke-linecap="round"/>
        <line x1="16" y1="56" x2="42" y2="56" stroke="#9aa3b2" stroke-width="3" stroke-linecap="round"/>
      `),

    drizzle: () =>
      svgShell(`
        ${cloud(8, 10, 1, "#9aa3b2")}
        <line x1="22" y1="42" x2="18" y2="50" stroke="#5aa7ff" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="32" y1="42" x2="28" y2="50" stroke="#5aa7ff" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="42" y1="42" x2="38" y2="50" stroke="#5aa7ff" stroke-width="2.5" stroke-linecap="round"/>
      `),

    rain: () =>
      svgShell(`
        ${cloud(8, 8, 1, "#9aa3b2")}
        <line x1="20" y1="40" x2="14" y2="52" stroke="#5aa7ff" stroke-width="3" stroke-linecap="round"/>
        <line x1="30" y1="40" x2="24" y2="52" stroke="#5aa7ff" stroke-width="3" stroke-linecap="round"/>
        <line x1="40" y1="40" x2="34" y2="52" stroke="#5aa7ff" stroke-width="3" stroke-linecap="round"/>
        <line x1="50" y1="40" x2="44" y2="52" stroke="#5aa7ff" stroke-width="3" stroke-linecap="round"/>
      `),

    heavyRain: () =>
      svgShell(`
        ${cloud(6, 6, 1.08, "#7a8494")}
        <line x1="18" y1="38" x2="12" y2="54" stroke="#3d8bf0" stroke-width="3.5" stroke-linecap="round"/>
        <line x1="28" y1="38" x2="22" y2="54" stroke="#3d8bf0" stroke-width="3.5" stroke-linecap="round"/>
        <line x1="38" y1="38" x2="32" y2="54" stroke="#3d8bf0" stroke-width="3.5" stroke-linecap="round"/>
        <line x1="48" y1="38" x2="42" y2="54" stroke="#3d8bf0" stroke-width="3.5" stroke-linecap="round"/>
      `),

    snow: () =>
      svgShell(`
        ${cloud(8, 8, 1, "#9aa3b2")}
        <circle cx="20" cy="46" r="2.5" fill="#e8eef7"/>
        <circle cx="30" cy="52" r="2.5" fill="#e8eef7"/>
        <circle cx="40" cy="46" r="2.5" fill="#e8eef7"/>
        <circle cx="50" cy="52" r="2.5" fill="#e8eef7"/>
      `),

    heavySnow: () =>
      svgShell(`
        ${cloud(6, 6, 1.08, "#7a8494")}
        <circle cx="16" cy="44" r="3" fill="#e8eef7"/>
        <circle cx="26" cy="50" r="3" fill="#e8eef7"/>
        <circle cx="36" cy="44" r="3" fill="#e8eef7"/>
        <circle cx="46" cy="50" r="3" fill="#e8eef7"/>
        <circle cx="52" cy="44" r="3" fill="#e8eef7"/>
      `),

    showers: () => SVG.rain(),

    heavyShowers: () => SVG.heavyRain(),

    thunder: () =>
      svgShell(`
        ${cloud(6, 8, 1.05, "#6b7280")}
        <polygon points="34,36 26,48 32,48 28,58 42,42 35,42 40,36" fill="#f5c84c"/>
      `),

    hail: () => SVG.thunder(),

    severe: () =>
      svgShell(`
        ${cloud(4, 6, 1.12, "#5c6370")}
        <polygon points="34,34 24,48 31,48 27,58 44,42 36,42 42,34" fill="#ff7a59"/>
        <line x1="18" y1="40" x2="12" y2="54" stroke="#5aa7ff" stroke-width="3" stroke-linecap="round"/>
        <line x1="48" y1="40" x2="42" y2="54" stroke="#5aa7ff" stroke-width="3" stroke-linecap="round"/>
      `),
  };

  window.WeatherIcons = {
    svg(code) {
      const type = typeForCode(code);
      return (SVG[type] || SVG.partlyCloudy)();
    },
    label(code) {
      return LABELS[typeForCode(code)] || "Weather";
    },
  };
})();
