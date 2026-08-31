/* Shared kiosk header: live clock, weekday/date, Rochelle weather + 4-day forecast */
(function () {
  const WEATHER_CACHE_KEY = "family-board-weather-cache-v2";
  const CACHE_MAX_MS = 20 * 60 * 1000;
  const POLL_MS = 60 * 1000;
  const HEADER_HTML = `
    <header class="header">
      <section class="panel clock-card" aria-label="Time">
        <div class="time" id="clock">—:—</div>
        <div class="date" id="clockDate"></div>
      </section>
      <section class="panel weather-strip" aria-label="Weather for Rochelle, IL">
        <div class="wx-now-compact">
          <div class="wx-icon" id="wxIcon" aria-hidden="true"></div>
          <div class="temp" id="wxTemp">--°</div>
        </div>
        <div class="forecast" id="forecast" aria-label="4 day forecast"></div>
      </section>
    </header>`;

  let weatherFp = "";
  let started = false;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function setWxIcon(el, code, isDay) {
    if (!el || !window.WeatherIcons) return;
    el.innerHTML = WeatherIcons.svg(code, isDay !== false);
  }

  function updateClock() {
    const now = new Date();
    const h = now.getHours();
    const nextTime = `${h % 12 || 12}:${pad(now.getMinutes())} ${h >= 12 ? "PM" : "AM"}`;
    const nextDate = now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const clock = document.getElementById("clock");
    const dateEl = document.getElementById("clockDate");
    if (clock && clock.textContent !== nextTime) clock.textContent = nextTime;
    if (dateEl && dateEl.textContent !== nextDate) dateEl.textContent = nextDate;
  }

  function applyWeatherData(data) {
    if (!data?.current || !data?.daily) return;
    const isDay = data.current.is_day !== 0 && data.current.is_day !== false;
    const fp = JSON.stringify({
      code: data.current.weather_code,
      t: data.current.temperature_2m,
      day: isDay,
      daily: data.daily,
      at: data.updatedAt || 0,
    });
    if (fp === weatherFp) return;
    weatherFp = fp;

    setWxIcon(document.getElementById("wxIcon"), data.current.weather_code, isDay);
    const tempEl = document.getElementById("wxTemp");
    if (tempEl && data.current.temperature_2m != null) {
      tempEl.textContent = `${Math.round(data.current.temperature_2m)}°`;
    }

    const root = document.getElementById("forecast");
    if (!root || !window.WeatherIcons) return;
    const today = new Date();
    const times = data.daily.time || [];
    root.innerHTML = times
      .slice(0, 4)
      .map((iso, i) => {
        const d = new Date(`${iso}T12:00:00`);
        const code = data.daily.weather_code[i];
        const name =
          i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" });
        const isToday =
          d.getDate() === today.getDate() && d.getMonth() === today.getMonth();
        return `
          <div class="fday${isToday ? " today" : ""}">
            <div class="d">${name}</div>
            <div class="ico">${WeatherIcons.svg(code, true)}</div>
            <div class="temps">
              <span class="hi">${Math.round(data.daily.temperature_2m_max[i])}°</span>
              <span class="lo">${Math.round(data.daily.temperature_2m_min[i])}°</span>
            </div>
          </div>`;
      })
      .join("");
  }

  function loadCachedWeather() {
    try {
      const raw = localStorage.getItem(WEATHER_CACHE_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached?.data?.current || !cached?.data?.daily) return false;
      if (Date.now() - Number(cached.savedAt || 0) > CACHE_MAX_MS) return false;
      applyWeatherData(cached.data);
      return true;
    } catch {
      return false;
    }
  }

  function saveWeatherCache(data) {
    try {
      localStorage.setItem(
        WEATHER_CACHE_KEY,
        JSON.stringify({ savedAt: Date.now(), data })
      );
    } catch (_) {
      /* quota / private mode */
    }
  }

  function openMeteoUrl() {
    const CFG = window.FAMILY_CONFIG;
    const wx = CFG?.weather || {};
    const latitude = wx.latitude ?? 41.9239;
    const longitude = wx.longitude ?? -89.0687;
    const temp = wx.tempUnit === "celsius" ? "celsius" : "fahrenheit";
    const wind = wx.windUnit === "kmh" ? "kmh" : "mph";
    const tz = wx.timezone || "America/Chicago";
    return (
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,is_day` +
      `&minutely_15=temperature_2m,weather_code,is_day` +
      `&forecast_minutely_15=8` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&temperature_unit=${temp}&wind_speed_unit=${wind}` +
      `&timezone=${encodeURIComponent(tz)}&forecast_days=4`
    );
  }

  async function fetchJson(url, timeoutMs) {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadWeather() {
    try {
      const data = await fetchJson("/api/weather", 12000);
      if (data?.current && data?.daily) {
        applyWeatherData(data);
        saveWeatherCache(data);
        return;
      }
    } catch (_) {
      /* fall through to Open-Meteo */
    }
    try {
      const data = await fetchJson(openMeteoUrl(), 12000);
      applyWeatherData(data);
      saveWeatherCache(data);
    } catch {
      if (!loadCachedWeather()) {
        setWxIcon(document.getElementById("wxIcon"), 2, true);
        const tempEl = document.getElementById("wxTemp");
        if (tempEl) tempEl.textContent = "--°";
      }
    }
  }

  function mount() {
    const slot = document.querySelector("[data-screen-chrome]");
    if (slot) slot.outerHTML = HEADER_HTML;
  }

  function init() {
    mount();
    if (!document.getElementById("clock")) return;
    updateClock();
    const activeOnly = window.DisplayActive?.whenActive || ((fn) => fn);
    if (window.DisplayActive?.isActive?.()) {
      loadCachedWeather();
      loadWeather();
    }
    if (started) return;
    started = true;
    setInterval(activeOnly(updateClock), 1000);
    setInterval(activeOnly(loadWeather), POLL_MS);
    window.addEventListener("online", activeOnly(loadWeather));
    document.addEventListener("visibilitychange", () => {
      if (!window.DisplayActive?.isActive?.()) return;
      updateClock();
      loadWeather();
    });
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type !== "fb-kiosk-shown") return;
      if (!window.DisplayActive?.isActive?.()) return;
      updateClock();
      loadCachedWeather();
      loadWeather();
    });
  }

  window.ScreenChrome = { init, updateClock, loadWeather };
})();
