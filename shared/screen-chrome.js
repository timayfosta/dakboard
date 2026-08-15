/* Shared kiosk header: live clock, weekday/date, weather + 4-day forecast */
(function () {
  const WEATHER_CACHE_KEY = "family-board-weather-cache-v1";
  const HEADER_HTML = `
    <header class="header">
      <section class="panel clock-card" aria-label="Time">
        <div class="time" id="clock">—:—</div>
        <div class="date" id="clockDate"></div>
      </section>
      <section class="panel weather-strip" aria-label="Weather">
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

  function setWxIcon(el, code) {
    if (!el || !window.WeatherIcons) return;
    el.innerHTML = WeatherIcons.svg(code);
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
    const fp = JSON.stringify({
      code: data.current.weather_code,
      t: data.current.temperature_2m,
      w: data.current.wind_speed_10m,
      daily: data.daily,
    });
    if (fp === weatherFp) return;
    weatherFp = fp;

    setWxIcon(document.getElementById("wxIcon"), data.current.weather_code);
    const tempEl = document.getElementById("wxTemp");
    if (tempEl) tempEl.textContent = `${Math.round(data.current.temperature_2m)}°`;

    const root = document.getElementById("forecast");
    if (!root || !window.WeatherIcons) return;
    const today = new Date();
    root.innerHTML = data.daily.time
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
            <div class="ico">${WeatherIcons.svg(code)}</div>
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
      applyWeatherData(cached.data);
      return true;
    } catch {
      return false;
    }
  }

  async function loadWeather() {
    const CFG = window.FAMILY_CONFIG;
    if (!CFG?.weather) return;
    const { latitude, longitude, tempUnit, windUnit, timezone } = CFG.weather;
    const temp = tempUnit === "celsius" ? "celsius" : "fahrenheit";
    const wind = windUnit === "kmh" ? "kmh" : "mph";
    const tz = timezone || "America/Chicago";
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&temperature_unit=${temp}&wind_speed_unit=${wind}&timezone=${encodeURIComponent(tz)}&forecast_days=4`;
    try {
      const data = await (await fetch(url, { signal: AbortSignal.timeout(4000) })).json();
      applyWeatherData(data);
      try {
        localStorage.setItem(
          WEATHER_CACHE_KEY,
          JSON.stringify({ savedAt: Date.now(), data })
        );
      } catch (_) {
        /* quota / private mode */
      }
    } catch {
      if (!loadCachedWeather()) {
        setWxIcon(document.getElementById("wxIcon"), 2);
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
    loadCachedWeather();
    loadWeather();
    if (started) return;
    started = true;
    setInterval(updateClock, 1000);
    setInterval(loadWeather, 5 * 60 * 1000);
    window.addEventListener("online", loadWeather);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        updateClock();
        loadWeather();
      }
    });
  }

  window.ScreenChrome = { init, updateClock, loadWeather };
})();
