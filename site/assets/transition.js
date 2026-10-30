/* Page-change animation: a hyperspace jump. Clicking a link accelerates a starfield into streaks with the
   destination's name in the centre; the next page opens at full warp and decelerates to reveal itself.
   Loaded in <head> so the arrival covers the page before its first paint. The overlay is deliberately always
   dark, in both themes: it's space. Navigation never depends on the animation finishing (see the timers). */
(function () {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const KEY = "chm-warp", EXIT_MS = 520, ARRIVE_MS = 780, ARRIVE_MAX_WAIT_MS = 900, PEAK = 3.2;
  const store = {
    take() { try { const v = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); return v; } catch (e) { return null; } },
    put(v) { try { sessionStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the next page just opens without the arrival */ } },
  };

  function overlay() {
    const cv = document.createElement("canvas");
    cv.className = "warp"; cv.setAttribute("aria-hidden", "true");
    const dpr = Math.min(devicePixelRatio || 1, 1.5), W = innerWidth, H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    document.documentElement.append(cv);
    const c = cv.getContext("2d");
    c.scale(dpr, dpr);
    const stars = Array.from({ length: Math.min(420, Math.round(W * H / 3200)) }, () => ({
      x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random(), hue: Math.random() < 0.28 ? "170,195,255" : "235,242,255",
    }));
    let last = performance.now();
    return {
      cv,
      // speed: star velocity; alpha: overlay opacity; flash: white-out at the centre; label: destination name
      frame(speed, alpha, flash, label) {
        const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
        const cx = W / 2, cy = H / 2, scale = Math.max(W, H) * 0.5;
        c.clearRect(0, 0, W, H);
        c.globalAlpha = alpha;
        c.fillStyle = "#050814"; c.fillRect(0, 0, W, H);
        c.lineCap = "round";
        for (const s of stars) {
          s.z -= speed * dt;
          if (s.z <= 0.02) { s.z = 1; s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; }
          const tail = Math.min(0.9, s.z + speed * 0.09);
          const x1 = cx + (s.x / s.z) * scale * 0.25, y1 = cy + (s.y / s.z) * scale * 0.25;
          const x0 = cx + (s.x / tail) * scale * 0.25, y0 = cy + (s.y / tail) * scale * 0.25;
          c.strokeStyle = `rgba(${s.hue},${Math.min(1, 1.15 - s.z)})`;
          c.lineWidth = Math.max(0.6, (1.3 - s.z) * 1.7);
          c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
        }
        if (flash > 0) {
          const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.62);
          g.addColorStop(0, `rgba(225,235,255,${flash})`);
          g.addColorStop(0.35, `rgba(140,163,255,${flash * 0.45})`);
          g.addColorStop(1, "rgba(140,163,255,0)");
          c.fillStyle = g; c.fillRect(0, 0, W, H);
        }
        if (label) {
          c.textAlign = "center"; c.textBaseline = "middle";
          c.font = '500 12px "IBM Plex Mono", ui-monospace, Consolas, monospace';
          c.fillStyle = "rgba(170,190,255,.9)";
          c.fillText("JUMPING TO", cx, cy - 26);
          c.font = `800 ${Math.round(Math.min(42, Math.max(24, W * 0.04)))}px "Archivo", "Arial Narrow", system-ui, sans-serif`;
          c.fillStyle = "#fff";
          c.fillText(label, cx, cy + 8);
        }
        c.globalAlpha = 1;
      },
    };
  }

  /* ---- leaving: accelerate into warp, then navigate ---- */
  let jumping = false;
  function warpTo(url, label) {
    if (jumping) return;
    jumping = true;
    store.put(label || "");
    const go = () => { location.href = url; };
    const fx = overlay(), t0 = performance.now();
    const safety = setTimeout(go, EXIT_MS + 150);   // rAF stops in hidden tabs; the navigation must still happen
    (function tick() {
      const k = Math.min(1, (performance.now() - t0) / EXIT_MS);
      fx.frame(0.15 + PEAK * k * k, Math.min(1, k * 2.4), k > 0.55 ? (k - 0.55) / 0.45 * 0.75 : 0, k > 0.12 ? label : "");
      if (k < 1) requestAnimationFrame(tick); else { clearTimeout(safety); go(); }
    })();
  }
  window.warpTo = warpTo;

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
    if (!/(\.html|\/)$/.test(a.pathname)) return;
    if (a.pathname === location.pathname && a.search === location.search) return;   // same page or a section on it
    e.preventDefault();
    const title = a.querySelector("b");
    warpTo(a.href, (title ? title.textContent : a.textContent.trim() || "Home"));
  });

  // Back/forward can restore a frozen page with the overlay still on it
  addEventListener("pageshow", (e) => {
    if (e.persisted) { jumping = false; document.querySelectorAll(".warp").forEach((x) => x.remove()); }
  });

  /* ---- arriving: start at full warp, hold until the page is parsed, then drop out ---- */
  const arriving = store.take();
  if (arriving === null) return;
  const fx = overlay();
  let t0 = null;
  const start = () => { if (t0 === null) t0 = performance.now(); };
  document.addEventListener("DOMContentLoaded", start);
  setTimeout(start, ARRIVE_MAX_WAIT_MS);
  setTimeout(() => fx.cv.remove(), ARRIVE_MAX_WAIT_MS + ARRIVE_MS + 300);
  (function tick() {
    if (!fx.cv.isConnected) return;
    if (t0 === null) { fx.frame(PEAK + 0.15, 1, 0.75, arriving); return requestAnimationFrame(tick); }
    const k = Math.min(1, (performance.now() - t0) / ARRIVE_MS), ease = 1 - Math.pow(1 - k, 3);
    fx.frame(0.15 + PEAK * (1 - ease), k < 0.35 ? 1 : 1 - (k - 0.35) / 0.65, Math.max(0, 0.75 * (1 - k * 2.6)), k < 0.3 ? arriving : "");
    if (k < 1) requestAnimationFrame(tick); else fx.cv.remove();
  })();
})();
