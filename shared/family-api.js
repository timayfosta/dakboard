/* Kiosk/display client for Family Board API */
(function () {
  async function getState() {
    const res = await fetch("/api/family/state", { cache: "no-store" });
    if (!res.ok) throw new Error(`Family state HTTP ${res.status}`);
    return res.json();
  }

  async function toggleChore(choreId, kidId) {
    const res = await fetch("/api/family/chores/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choreId, kidId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Toggle failed");
    return data;
  }

  async function toggleListItem(name, itemId) {
    const res = await fetch("/api/family/lists/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, itemId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Toggle failed");
    return data;
  }

  async function addListItem(name, text) {
    const res = await fetch("/api/family/lists/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Add failed");
    return data;
  }

  async function redeemReward(rewardId, kidId) {
    const res = await fetch("/api/family/rewards/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rewardId, kidId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Redeem failed");
    return data;
  }

  async function getWhiteboard() {
    const res = await fetch("/api/family/whiteboard", { cache: "no-store" });
    if (!res.ok) throw new Error(`Whiteboard HTTP ${res.status}`);
    return res.json();
  }

  async function saveWhiteboard(strokes) {
    const res = await fetch("/api/family/whiteboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strokes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");
    return data;
  }

  async function getScreensaverManifest() {
    const res = await fetch("/api/screensaver/manifest", { cache: "no-store" });
    if (!res.ok) throw new Error(`Screensaver HTTP ${res.status}`);
    return res.json();
  }

  window.FamilyAPI = {
    getState,
    toggleChore,
    toggleListItem,
    addListItem,
    redeemReward,
    getWhiteboard,
    saveWhiteboard,
    getScreensaverManifest,
  };
})();
