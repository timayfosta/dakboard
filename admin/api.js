const API = {
  async request(path, { method = "GET", body, token, filesToken } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (filesToken) headers["X-Files-Token"] = filesToken;
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) {
      window.dispatchEvent(new CustomEvent("admin-unauthorized"));
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  login: (password) => API.request("/api/auth/login", { method: "POST", body: { password } }),
  session: (token) => API.request("/api/auth/me", { token }),
  health: () => API.request("/api/health"),
  state: () => API.request("/api/family/state"),
  saveKid: (token, item) => API.request("/api/family/kids", { method: "POST", token, body: item }),
  saveChore: (token, item) => API.request("/api/family/chores", { method: "POST", token, body: item }),
  saveConsequence: (token, item) =>
    API.request("/api/family/consequences", { method: "POST", token, body: item }),
  applyConsequence: (token, id, kidIds) =>
    API.request("/api/family/consequences/apply", { method: "POST", token, body: { id, kidIds } }),
  saveReward: (token, item) => API.request("/api/family/rewards", { method: "POST", token, body: item }),
  adjustStars: (token, kidId, delta) =>
    API.request("/api/family/stars", { method: "POST", token, body: { kidId, delta } }),
  replaceList: (token, name, items) =>
    API.request("/api/family/lists/replace", { method: "POST", token, body: { name, items } }),
  addListItem: (name, text) =>
    API.request("/api/family/lists/add", { method: "POST", body: { name, text } }),
  toggleListItem: (token, name, itemId) =>
    API.request("/api/family/lists/toggle", { method: "POST", token, body: { name, itemId } }),
  restoreListItem: (name, item, index) =>
    API.request("/api/family/lists/restore", { method: "POST", body: { name, item, index } }),
  clearCompletedList: (token, name) =>
    API.request("/api/family/lists/clear-completed", { method: "POST", token, body: { name } }),
  deleteListItem: (token, name, itemId) =>
    API.request(`/api/family/lists/${name}/${itemId}`, { method: "DELETE", token }),
  deleteKid: (token, id) => API.request(`/api/family/kids/${id}`, { method: "DELETE", token }),
  deleteChore: (token, id) => API.request(`/api/family/chores/${id}`, { method: "DELETE", token }),
  deleteConsequence: (token, id) => API.request(`/api/family/consequences/${id}`, { method: "DELETE", token }),
  deleteReward: (token, id) => API.request(`/api/family/rewards/${id}`, { method: "DELETE", token }),
  saveSettings: (token, settings) =>
    API.request("/api/family/settings", { method: "POST", token, body: settings }),
  uploadPhoto: (token, item) =>
    API.request("/api/screensaver/upload", { method: "POST", token, body: item }),
  deletePhoto: (token, id) =>
    API.request(`/api/screensaver/photos/${id}`, { method: "DELETE", token }),
  restartServer: (token) =>
    API.request("/api/admin/restart", { method: "POST", token, body: {} }),
  deploy: (token) => API.request("/api/admin/deploy", { method: "POST", token, body: {} }),
  deployStatus: (token) => API.request("/api/admin/deploy/status", { token }),
  rebootPi: (token) => API.request("/api/admin/reboot", { method: "POST", token, body: {} }),
  startTunnel: (token) => API.request("/api/admin/tunnel-start", { method: "POST", token, body: {} }),
  unlockFiles: (token, password) =>
    API.request("/api/admin/files/unlock", { method: "POST", token, body: { password } }),
  listFiles: (token, filesToken) => API.request("/api/admin/files", { token, filesToken }),
  getFile: (token, id, filesToken) => API.request(`/api/admin/files/${id}`, { token, filesToken }),
  saveFile: (token, id, content, filesToken) =>
    API.request(`/api/admin/files/${id}`, { method: "POST", token, body: { content }, filesToken }),
  browse: (token, path, filesToken) =>
    API.request(`/api/admin/browse?path=${encodeURIComponent(path || "")}`, { token, filesToken }),
  readBrowseFile: (token, path, filesToken) =>
    API.request(`/api/admin/browse/file?path=${encodeURIComponent(path || "")}`, { token, filesToken }),
  saveBrowseFile: (token, path, content, filesToken) =>
    API.request("/api/admin/browse/file", { method: "POST", token, body: { path, content }, filesToken }),
};

window.AdminAPI = API;
