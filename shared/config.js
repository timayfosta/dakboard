/* ===== Family Board config — edit this for your family ===== */
window.FAMILY_CONFIG = {
  familyName: "Family Board",

  /* Portrait design canvas (32" vertical ≈ 1080×1920). Scales to fit any display. */
  display: {
    width: 1080,
    height: 1920,
    /* Pi kiosk desktop rotation: left | right | normal | inverted
       (also set in scripts/pi/kiosk.env as FAMILY_BOARD_ROTATE) */
    rotate: "right",
  },

  /* Open-Meteo + NWS alerts use lat/lon. Update for your home. */
  weather: {
    latitude: 41.9239,
    longitude: -89.0687,
    placeLabel: "Rochelle, IL",
    timezone: "America/Chicago",
    tempUnit: "fahrenheit", // or "celsius"
    windUnit: "mph", // or "kmh"
    /* Show banner for these NWS event keywords (case-insensitive match) */
    alertKeywords: [
      "Tornado",
      "Severe Thunderstorm",
      "Flash Flood",
      "Winter Storm",
      "Blizzard",
      "Ice Storm",
      "Hurricane",
      "Tropical Storm",
      "Heat",
      "Wind Chill",
      "Extreme Cold",
      "Fire Weather",
      "Flood Warning",
      "Flood Watch",
    ],
  },

  /*
   * Google Calendar
   * ---------------
   * Easiest now: create a Google Cloud API key, enable Calendar API,
   * and make the calendar free/busy or public "See all event details",
   * OR share the calendar with the API project later via OAuth (Cloudflare).
   *
   * For private family calendars, we'll add a Cloudflare Worker proxy next.
   * Leave apiKey empty to use demo events while designing the layout.
   */
  googleCalendar: {
    apiKey: "AIzaSyAXYnqlAwVT6TVS3QQ1bC548MzG58Ymfcg",
    calendarId: "family00724596334294402291@group.calendar.google.com",
    maxUpcoming: 15,
    daysAhead: 21,
    /*
     * Private calendar (recommended): leave calendar private and use a
     * local/Cloudflare proxy for the secret iCal URL.
     * Local: python server.py → "/api/calendar"
     * Cloudflare: worker URL after deploy
     */
    proxyUrl: "/api/calendar",
  },

  /* Demo events used when Google Calendar isn't connected yet */
  demoEvents: [
    { title: "School drop-off", start: "today+0T07:45", end: "today+0T08:10", allDay: false },
    { title: "Soccer practice", start: "today+0T17:00", end: "today+0T18:15", allDay: false },
    { title: "Grocery run", start: "today+1T10:00", end: "today+1T11:00", allDay: false },
    { title: "Dentist — Leo", start: "today+1T15:30", end: "today+1T16:15", allDay: false },
    { title: "Library story time", start: "today+2T11:00", end: "today+2T12:00", allDay: false },
    { title: "Swim lessons", start: "today+3T16:30", end: "today+3T17:15", allDay: false },
    { title: "Game night", start: "today+4T19:00", end: "today+4T21:00", allDay: false },
    { title: "Church", start: "today+5T09:00", end: "today+5T10:30", allDay: false },
    { title: "Birthday party", start: "today+6T14:00", end: "today+6T16:00", allDay: false },
    { title: "Teacher conferences", start: "today+7T12:00", end: "today+7T18:00", allDay: false },
    { title: "Scout meeting", start: "today+8T18:30", end: "today+8T19:30", allDay: false },
    { title: "Family dinner out", start: "today+9T17:30", end: "today+9T19:00", allDay: false },
    { title: "Spring recital", start: "today+11T18:00", end: "today+11T20:00", allDay: false },
    { title: "Park picnic", start: "today+12", end: "today+12", allDay: true },
    { title: "Grandma visit", start: "today+14", end: "today+14", allDay: true },
  ],

  groceryDefaults: [
    "Milk",
    "Bread",
    "Eggs",
    "Bananas",
    "Chicken",
    "Yogurt",
  ],

  reminderDefaults: [
    "Permission slips due Friday",
    "Trash/recycling night",
    "Pay soccer fees",
    "Call dentist to confirm",
  ],

  kids: [
    { id: "maya", name: "Maya", emoji: "🦎", color: "#3ecf8e" },
    { id: "leo", name: "Leo", emoji: "🚀", color: "#3aa0e8" },
    { id: "zoe", name: "Zoe", emoji: "🌈", color: "#e85d9a" },
    { id: "sam", name: "Sam", emoji: "⚡", color: "#ffc94a" },
    { id: "ava", name: "Ava", emoji: "🦄", color: "#ff6b4a" },
    { id: "max", name: "Max", emoji: "🦖", color: "#2bbbad" },
  ],

  choreCatalog: {
    bed: { title: "Make bed", hint: "Pull covers neat", stars: 1, icon: "🛏️" },
    dishes: { title: "Clear dishes", hint: "After meals", stars: 2, icon: "🍽️" },
    tidy: { title: "10-min tidy", hint: "Toys in bins", stars: 2, icon: "🧸" },
    homework: { title: "Homework ready", hint: "Folder in backpack", stars: 1, icon: "📚" },
    trash: { title: "Trash run", hint: "Kitchen bin out", stars: 2, icon: "🗑️" },
    pets: { title: "Feed pets", hint: "Food + water", stars: 2, icon: "🐾" },
    plants: { title: "Water plants", hint: "Kitchen window", stars: 1, icon: "🌱" },
    laundry: { title: "Laundry helper", hint: "Bring basket down", stars: 2, icon: "👕" },
    shoes: { title: "Shoes by door", hint: "Pairs lined up", stars: 1, icon: "👟" },
    reading: { title: "Reading time", hint: "15 minutes", stars: 1, icon: "📖" },
    table: { title: "Set the table", hint: "Plates + cups", stars: 2, icon: "🍴" },
    bathroom: { title: "Bathroom wipe", hint: "Sink sparkle", stars: 2, icon: "✨" },
  },

  choresByKid: {
    maya: ["bed", "pets", "dishes", "homework", "tidy"],
    leo: ["bed", "trash", "reading", "shoes", "plants"],
    zoe: ["bed", "table", "homework", "tidy", "laundry"],
    sam: ["bed", "trash", "shoes", "reading", "dishes"],
    ava: ["bed", "pets", "table", "tidy", "homework"],
    max: ["bed", "plants", "shoes", "bathroom", "reading"],
  },

  allDoneBonus: 3,

  rewards: [
    { id: "screen15", title: "15 min extra screen", cost: 8, icon: "📱", vibe: "quick" },
    { id: "dessert", title: "Pick dessert", cost: 10, icon: "🍦", vibe: "treat" },
    { id: "stayup", title: "Stay up 30 min late", cost: 12, icon: "🌙", vibe: "night" },
    { id: "game", title: "Choose family game", cost: 14, icon: "🎲", vibe: "fun" },
    { id: "dinner", title: "Pick dinner night", cost: 18, icon: "🍕", vibe: "feast" },
    { id: "friend", title: "Friend playdate", cost: 22, icon: "🎉", vibe: "social" },
    { id: "movie", title: "Pick movie night", cost: 16, icon: "🎬", vibe: "fun" },
    { id: "park", title: "Park trip vote", cost: 20, icon: "🏞️", vibe: "outdoors" },
  ],

  cheers: [
    "Boom — chore crushed!",
    "Star power!",
    "You're on fire!",
    "Legend move!",
    "High five energy!",
    "Quest complete!",
    "Superstar status!",
  ],
};
