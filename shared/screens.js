/* Kiosk screen registry — add new screens here; rotation timing is configured in admin */
window.FAMILY_SCREENS = {
  /** Fallback seconds per screen when server settings are unavailable */
  rotationSeconds: 45,
  /** Pause auto-rotation after touch interaction */
  pauseOnTouchSeconds: 120,  /** Minimum horizontal swipe distance (px) to change screen */
  swipeThreshold: 60,
  screens: [
    {
      id: "calendar",
      title: "Home",
      icon: "📅",
      path: "/screens/calendar.html",
      enabled: true,
    },
    {
      id: "chores",
      title: "Chores",
      icon: "✅",
      path: "/screens/chores.html",
      enabled: true,
    },
    {
      id: "rewards",
      title: "Rewards",
      icon: "🎁",
      path: "/screens/rewards.html",
      enabled: true,
    },
    {
      id: "whiteboard",
      title: "Board",
      icon: "📝",
      path: "/screens/whiteboard.html",
      enabled: true,
    },
    /* Future screens — set enabled: true when ready, e.g.:
    {
      id: "meals",
      title: "Meals",
      icon: "🍽️",
      path: "/screens/meals.html",
      enabled: false,
    },
    */
  ],
};
