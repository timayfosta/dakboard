/* Example secrets — copy to secrets.local.js (gitignored). Never commit real tokens. */
window.FAMILY_SECRETS = {
  /* Google Calendar → Settings → Integrate calendar → Secret address in iCal format */
  icsUrl: "https://calendar.google.com/calendar/ical/YOUR_CAL_ID/private-YOUR_SECRET/basic.ics",

  adminPassword: "family",

  /* Google Calendar API OAuth (for event colors). Keep these only in secrets.local.js */
  googleClientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  googleClientSecret: "YOUR_CLIENT_SECRET",
  googleRefreshToken: "1//YOUR_REFRESH_TOKEN",

  /* Optional extra password for the admin file browser */
  filesPassword: "YOUR_FILES_PASSWORD",
};
