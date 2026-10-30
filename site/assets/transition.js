/* Page-change animation: a hyperspace jump. Clicking a link accelerates a starfield into streaks with the
   destination's name in the centre; the same stars carry over to the next page, which opens at full warp and
   decelerates to reveal itself. Loaded in <head> so the arrival covers the page before its first paint.
   The overlay is deliberately always dark, in both themes: it's space.
   Navigation never depends on the animation finishing (see the timers). */
(function () {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const KEY = "chm-warp", EXIT_MS = 560, ARRIVE_MS = 950, ARRIVE_MAX_WAIT_MS = 1000, PEAK = 3.2, BASE = 0.12, FLASH = 0.7;
  const smooth = (k) => { const t = Math.max(0, Math.min(1, k)); return t * t * (3 - 2 * t); };
  const store = {
    take() {
      try { const v = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); return v ? JSON.parse(v) : null; }
      catch (e) { return null; }
    },
    put(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: the next page opens without the arrival */ } },
  };

  function overlay(saved) {
    const cv = document.createElement("canvas");
    cv.className = "warp"; cv.setAttribute("aria-hidden", "true");
    const dpr = Math.min(devicePixelRatio || 1, 1.5), W = innerWidth, H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    document.documentElement.append(cv);
    const c = cv.getContext("2d");
    c.scale(dpr, dpr);
    const stars = saved && saved.length ? saved : Array.from({ length: Math.min(380, Math.round(W * H / 3400)) }, () =>
      [(Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, Math.random(), Math.random() < 0.28 ? 1 : 0]);
    const COLORS = ["235,242,255", "170,195,255"];
    let last = performance.now();
    return {
      cv,
      stars: () => stars.map((s) => [+s[0].toFixed(3), +s[1].toFixed(3), +s[2].toFixed(3), s[3]]),
      // speed: star velocity; alpha: overlay opacity; flash: glow at the centre; label + labelAlpha: destination name
      frame(speed, alpha, flash, label, labelAlpha) {
        const now = performance.now(), dt = Math.min(0.034, (now - last) / 1000); last = now;
        const cx = W / 2, cy = H / 2, scale = Math.max(W, H) * 0.125;
        c.clearRect(0, 0, W, H);
        c.globalAlpha = alpha;
        c.fillStyle = "#050814"; c.fillRect(0, 0, W, H);
        c.lineCap = "round";
        for (const s of stars) {
          s[2] -= speed * dt;
          if (s[2] <= 0.02) { s[0] = (Math.random() - 0.5) * 2; s[1] = (Math.random() - 0.5) * 2; s[2] = 1; }
          const z = s[2], tail = Math.min(1, z + speed * 0.09);
          c.strokeStyle = `rgba(${COLORS[s[3]]},${Math.min(1, 1.1 - z)})`;
          c.lineWidth = Math.max(0.6, (1.3 - z) * 1.7);
          c.beginPath();
          c.moveTo(cx + (s[0] / tail) * scale, cy + (s[1] / tail) * scale);
          c.lineTo(cx + (s[0] / z) * scale, cy + (s[1] / z) * scale);
          c.stroke();
        }
        if (flash > 0.005) {
          const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.62);
          g.addColorStop(0, `rgba(225,235,255,${flash})`);
          g.addColorStop(0.35, `rgba(140,163,255,${flash * 0.45})`);
          g.addColorStop(1, "rgba(140,163,255,0)");
          c.fillStyle = g; c.fillRect(0, 0, W, H);
        }
        if (label && labelAlpha > 0.005) {
          c.globalAlpha = alpha * labelAlpha;
          c.textAlign = "center"; c.textBaseline = "middle";
          c.font = '500 12px "IBM Plex Mono", ui-monospace, Consolas, monospace';
          c.fillStyle = "#aabeff";
          c.fillText("JUMPING TO", cx, cy - 26);
          c.font = `800 ${Math.round(Math.min(42, Math.max(24, W * 0.04)))}px "Archivo", "Arial Narrow", system-ui, sans-serif`;
          c.fillStyle = "#fff";
          c.fillText(label, cx, cy + 8);
        }
        c.globalAlpha = 1;
      },
    };
  }

  /* ---- leaving: accelerate into warp, then keep flying until the next page takes over ---- */
  let jumping = false;
  function warpTo(url, label) {
    if (jumping) return;
    jumping = true;
    const fx = overlay(), t0 = performance.now();
    let gone = false;
    const go = () => { if (gone) return; gone = true; store.put({ label, stars: fx.stars() }); location.href = url; };
    const safety = setTimeout(go, EXIT_MS + 150);   // rAF stops in hidden tabs; the navigation must still happen
    addEventListener("pagehide", () => store.put({ label, stars: fx.stars() }), { once: true });
    (function tick() {
      if (!fx.cv.isConnected) return;
      const k = Math.min(1, (performance.now() - t0) / EXIT_MS);
      fx.frame(BASE + PEAK * k * k * k, smooth(k * 2.2), FLASH * smooth((k - 0.45) / 0.55), label, smooth((k - 0.1) / 0.3));
      if (k >= 1) { clearTimeout(safety); go(); }
      requestAnimationFrame(tick);
    })();
  }
  window.warpTo = warpTo;

  // Architecture has its own arrival: fade to dark here, then its 3D CubeSat takes over (see initExplode in app.js)
  function fadeToIntro(url) {
    if (jumping) return;
    jumping = true;
    const veil = document.createElement("div");
    veil.className = "warp"; veil.style.cssText = "background:#050814;opacity:0;transition:opacity .3s ease";
    document.documentElement.append(veil);
    void veil.offsetWidth;
    veil.style.opacity = "1";
    store.put({ intro: true });
    setTimeout(() => { location.href = url; }, 320);
  }

  const samePage = (a) => a.pathname.replace(/index\.html$/, "") === location.pathname.replace(/index\.html$/, "") && a.search === location.search;
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
    if (!/(\.html|\/)$/.test(a.pathname)) return;
    e.preventDefault();
    if (samePage(a)) { scrollTo({ top: 0, behavior: "smooth" }); return; }   // already here: no reload or jump
    if (/architecture\.html$/.test(a.pathname)) { fadeToIntro(a.href); return; }
    const title = a.querySelector("b");
    warpTo(a.href, title ? title.textContent : (a.querySelector(".brand-txt") ? "Home" : a.textContent.trim()));
  });

  // Back/forward can restore a frozen page with the overlay still on it
  addEventListener("pageshow", (e) => {
    if (e.persisted) { jumping = false; document.querySelectorAll(".warp").forEach((x) => x.remove()); }
  });

  /* ---- arriving: same stars at full warp, hold until the page is parsed, then drop out ---- */
  const arriving = store.take();
  if (!arriving) return;
  if (arriving.intro) {
    const root = document.documentElement;
    root.classList.add("arch-intro");
    setTimeout(() => root.classList.remove("arch-intro", "arch-reveal"), 10000);   // safety net if the 3D view never starts
    return;
  }
  const fx = overlay(arriving.stars);
  let t0 = null;
  const start = () => { if (t0 === null) requestAnimationFrame(() => { if (t0 === null) t0 = performance.now(); }); };
  document.addEventListener("DOMContentLoaded", start);
  setTimeout(start, ARRIVE_MAX_WAIT_MS);
  setTimeout(() => fx.cv.remove(), ARRIVE_MAX_WAIT_MS + ARRIVE_MS + 400);
  (function tick() {
    if (!fx.cv.isConnected) return;
    if (t0 === null) { fx.frame(BASE + PEAK, 1, FLASH, arriving.label, 1); return requestAnimationFrame(tick); }
    const k = Math.min(1, (performance.now() - t0) / ARRIVE_MS), decel = Math.pow(1 - k, 3);
    fx.frame(BASE + PEAK * decel, 1 - smooth((k - 0.3) / 0.7), FLASH * (1 - smooth(k / 0.45)), arriving.label, 1 - smooth(k / 0.35));
    if (k < 1) requestAnimationFrame(tick); else fx.cv.remove();
  })();
})();
