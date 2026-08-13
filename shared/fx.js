/* Celebration FX — random exciting effects (not only confetti) */
window.FamilyFX = {
  burst(root, count = 30) {
    this.confetti(root, count);
  },

  celebrate(root, originEl) {
    if (!root) return "none";
    const kinds = [
      "emojiRain",
      "starBurst",
      "ringPulse",
      "fireworks",
      "coinFountain",
      "sparkShockwave",
      "ribbonPop",
      "megaParty",
      "laserStars",
    ];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    this[kind](root, originEl);
    return kind;
  },

  megaParty(root, originEl) {
    this.fireworks(root);
    this.emojiRain(root);
    this.coinFountain(root, originEl);
  },

  laserStars(root, originEl) {
    this.ringPulse(root, originEl);
    this.starBurst(root, originEl);
    this.ribbonPop(root);
  },

  confetti(root, count = 28) {
    const colors = ["#ff7a59", "#f5c84c", "#3ddc97", "#5aa7ff", "#f472b6", "#2dd4bf"];
    for (let i = 0; i < count; i++) {
      const bit = document.createElement("div");
      bit.className = "fx-bit";
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.background = colors[i % colors.length];
      bit.style.animationDuration = `${1.2 + Math.random() * 1.2}s`;
      bit.style.animationDelay = `${Math.random() * 0.12}s`;
      root.appendChild(bit);
      setTimeout(() => bit.remove(), 2600);
    }
  },

  emojiRain(root) {
    const emojis = ["⭐", "✨", "🎉", "🚀", "💫", "🔥", "🏆", "💥", "🌈", "⚡"];
    for (let i = 0; i < 18; i++) {
      const el = document.createElement("div");
      el.className = "fx-emoji";
      el.textContent = emojis[i % emojis.length];
      el.style.left = `${8 + Math.random() * 84}%`;
      el.style.fontSize = `${1.4 + Math.random() * 1.6}rem`;
      el.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
      el.style.animationDelay = `${Math.random() * 0.2}s`;
      root.appendChild(el);
      setTimeout(() => el.remove(), 2800);
    }
  },

  starBurst(root, originEl) {
    const rect = originEl?.getBoundingClientRect?.();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    for (let i = 0; i < 14; i++) {
      const el = document.createElement("div");
      el.className = "fx-star";
      el.textContent = "★";
      const ang = (Math.PI * 2 * i) / 14;
      const dist = 80 + Math.random() * 120;
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
      el.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
      el.style.setProperty("--dy", `${Math.sin(ang) * dist}px`);
      el.style.color = ["#f5c84c", "#ff7a59", "#fff"][i % 3];
      root.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }
  },

  ringPulse(root, originEl) {
    const rect = originEl?.getBoundingClientRect?.();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    for (let i = 0; i < 3; i++) {
      const el = document.createElement("div");
      el.className = "fx-ring";
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
      el.style.animationDelay = `${i * 0.12}s`;
      root.appendChild(el);
      setTimeout(() => el.remove(), 1000);
    }
  },

  fireworks(root) {
    const colors = ["#ff7a59", "#f5c84c", "#3ddc97", "#5aa7ff", "#f472b6"];
    for (let burst = 0; burst < 3; burst++) {
      const cx = 20 + Math.random() * 60;
      const cy = 18 + Math.random() * 35;
      for (let i = 0; i < 12; i++) {
        const el = document.createElement("div");
        el.className = "fx-spark";
        const ang = (Math.PI * 2 * i) / 12;
        el.style.left = `${cx}%`;
        el.style.top = `${cy}%`;
        el.style.background = colors[(i + burst) % colors.length];
        el.style.setProperty("--dx", `${Math.cos(ang) * (40 + Math.random() * 50)}px`);
        el.style.setProperty("--dy", `${Math.sin(ang) * (40 + Math.random() * 50)}px`);
        el.style.animationDelay = `${burst * 0.15}s`;
        root.appendChild(el);
        setTimeout(() => el.remove(), 1200);
      }
    }
  },

  coinFountain(root, originEl) {
    const rect = originEl?.getBoundingClientRect?.();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight * 0.55;
    for (let i = 0; i < 16; i++) {
      const el = document.createElement("div");
      el.className = "fx-coin";
      el.textContent = "★";
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
      el.style.setProperty("--dx", `${-60 + Math.random() * 120}px`);
      el.style.setProperty("--dy", `${-140 - Math.random() * 90}px`);
      el.style.animationDelay = `${Math.random() * 0.15}s`;
      root.appendChild(el);
      setTimeout(() => el.remove(), 1400);
    }
  },

  sparkShockwave(root, originEl) {
    this.ringPulse(root, originEl);
    this.starBurst(root, originEl);
    if (originEl) {
      originEl.classList.remove("fx-shake");
      void originEl.offsetWidth;
      originEl.classList.add("fx-shake");
      setTimeout(() => originEl.classList.remove("fx-shake"), 450);
    }
  },

  ribbonPop(root) {
    const colors = ["#ff7a59", "#f5c84c", "#5aa7ff", "#3ddc97", "#f472b6"];
    for (let i = 0; i < 20; i++) {
      const el = document.createElement("div");
      el.className = "fx-ribbon";
      el.style.left = `${Math.random() * 100}%`;
      el.style.background = colors[i % colors.length];
      el.style.width = `${8 + Math.random() * 10}px`;
      el.style.height = `${18 + Math.random() * 22}px`;
      el.style.animationDuration = `${1.3 + Math.random()}s`;
      el.style.animationDelay = `${Math.random() * 0.2}s`;
      root.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    }
  },

  floatLabel(originEl, text) {
    if (!originEl) return;
    const rect = originEl.getBoundingClientRect();
    const el = document.createElement("div");
    el.className = "fx-float-label";
    el.textContent = text;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top = `${rect.top}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  },
};
