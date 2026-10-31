/**
 * Minimal Chrome DevTools Protocol client for the ZCode desktop renderer.
 *
 * ZCode (production) starts without a debug port; the launcher must start it
 * with `--remote-debugging-port=<port>` before this module can connect.
 */

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class CdpError extends Error {}

export async function listTargets(port: number, host = "127.0.0.1"): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new CdpError(`Cannot reach CDP at ${host}:${port} — is ZCode running with --remote-debugging-port=${port}?`);
  }
  if (!res.ok) throw new CdpError(`CDP /json/list returned HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

/** The main chat window renderer; excludes helper pages and overlay panels. */
export function pickRendererTargets(targets: CdpTarget[]): CdpTarget[] {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const main = pages.filter(
    (t) => t.url.includes("out/renderer/index.html") || t.title === "ZCode"
  );
  return main.length > 0 ? main : pages.filter((t) => !t.url.includes("devtools://"));
}

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Set<(params: any) => void>>();
  readonly targetUrl: string;

  private constructor(wsUrl: string) {
    this.targetUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new CdpError(`${msg.error.message} (code ${msg.error.code})`));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.eventHandlers.get(msg.method)?.forEach((h) => h(msg.params));
      }
    });
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new CdpError("CDP connection closed"));
      this.pending.clear();
    });
  }

  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const conn = new CdpConnection(wsUrl);
      const timer = setTimeout(() => reject(new CdpError("CDP websocket connect timeout")), 5000);
      conn.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(conn);
      });
      conn.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError(`CDP websocket error for ${wsUrl}`));
      });
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: any) => void): void {
    let set = this.eventHandlers.get(event);
    if (!set) this.eventHandlers.set(event, (set = new Set()));
    set.add(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export interface InjectionPayload {
  /** CSS text covering :root/.dark variable overrides + wallpaper layer styling. */
  css: string;
  /** Optional data-URI wallpaper image; empty to skip the wallpaper layer. */
  wallpaperDataUri?: string;
  /** Optional video wallpaper URL (file:// or loopback stream); wins over the image layer. */
  videoUrl?: string;
  /** Loopback stream URL: error fallback, and the primary source when the
   *  canvas must stay untainted for frame sampling. */
  videoFallbackUrl?: string;
  /** Whether the video layer starts muted (autoplay policy). */
  videoMuted?: boolean;
  /** Load the video from the CORS-enabled stream and sample frames to re-tint
   *  UI accents while it plays. */
  videoLiveColor?: boolean;
  /** Web page wallpaper URL (sandboxed iframe layer, topmost when set). */
  webUrl?: string;
  /** Performance guard switches. */
  perfGuard?: { pauseHidden: boolean; batteryStill: boolean };
  /** Loopback API base + token: the script calls video-stop / wallpaper-path
   *  on its own for battery fallback and codec degrade. */
  apiBase?: string;
  apiToken?: string;
  /** Filesystem path of the current video (battery-restore re-apply). */
  videoSourcePath?: string;
  /** Pseudo-dynamic effect configuration. */
  effects?: {
    kenburns: boolean;
    parallax: boolean;
    particles: "none" | "snow" | "petals" | "light";
    intensity: number;
  };
  /** Unique-ish id so re-injection is idempotent. */
  marker?: string;
  /** "contain" additionally drives a blurred backdrop layer behind the image. */
  fit?: "cover" | "contain";
}

/**
 * Injects CSS + a persistence script into one renderer target. The script is
 * registered via Page.addScriptToEvaluateOnNewDocument so it survives reloads
 * for as long as this CDP session lives.
 */
export async function injectIntoTarget(
  target: CdpTarget,
  payload: InjectionPayload
): Promise<void> {
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
  try {
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    const bootstrap = buildBootstrapScript(payload);
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
    await conn.send("Runtime.evaluate", {
      expression: bootstrap,
      returnByValue: true,
    });
  } finally {
    conn.close();
  }
}

export function buildBootstrapScript(payload: InjectionPayload): string {
  const marker = payload.marker ?? "zcode-beautify";
  return `(function(){
  var MARKER = ${JSON.stringify(marker)};
  if (!window.__zcodeBeautify) window.__zcodeBeautify = {};
  // No early-return on unchanged payload: every operation below is idempotent
  // (getElementById reuse), and skipping would also skip the video play/retry
  // setup, leaving a paused video element behind.

  var style = document.getElementById(MARKER + '-style');
  if (!style) {
    style = document.createElement('style');
    style.id = MARKER + '-style';
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = ${JSON.stringify(payload.css)};

  var wp = document.getElementById(MARKER + '-wallpaper');
  var video = document.getElementById(MARKER + '-video');
  var VIDEO_URL = ${JSON.stringify(payload.videoUrl ?? "")};
  var VIDEO_STREAM = ${JSON.stringify(payload.videoFallbackUrl ?? "")};
  var PREFER_STREAM = ${JSON.stringify(Boolean(payload.videoLiveColor))};
  var PRIMARY_SRC = PREFER_STREAM && VIDEO_STREAM ? VIDEO_STREAM : VIDEO_URL;
  var MUTED = ${JSON.stringify(payload.videoMuted !== false)};
  // Perf-guard state, re-published on every injection; the once-attached
  // listeners below always read the latest values through it.
  window.__zbPerf = {
    pauseHidden: ${JSON.stringify(payload.perfGuard?.pauseHidden !== false)},
    batteryStill: ${JSON.stringify(payload.perfGuard?.batteryStill !== false)},
    apiBase: ${JSON.stringify(payload.apiBase ?? "")},
    apiToken: ${JSON.stringify(payload.apiToken ?? "")},
    videoSourcePath: ${JSON.stringify(payload.videoSourcePath ?? "")}
  };
  if (VIDEO_URL) {
    // The still image layer stands down while a video wallpaper is set.
    if (wp) { wp.remove(); wp = null; }
    if (!video) {
      video = document.createElement('video');
      video.id = MARKER + '-video';
      video.setAttribute('autoplay', '');
      video.setAttribute('muted', '');
      video.setAttribute('loop', '');
      video.setAttribute('playsinline', '');
      video.preload = 'auto';
      video.muted = MUTED;
      document.documentElement.appendChild(video);
      video.__zbFallback = false;
      video.addEventListener('error', function () {
        // file:// subresource loads can be refused by the host's web
        // preferences; the loopback stream is the second chance. If the stream
        // fails too (unsupported codec), degrade to the still image instead of
        // showing a black video.
        if (!video.__zbFallback && VIDEO_STREAM && video.src.indexOf('file:') === 0) {
          video.__zbFallback = true;
          video.setAttribute('data-src', VIDEO_STREAM);
          video.src = VIDEO_STREAM;
          var fp = video.play();
          if (fp && fp.catch) fp.catch(function () {});
        } else if (video.__zbFallback && !video.__zbDegraded) {
          video.__zbDegraded = true;
          var perf = window.__zbPerf || {};
          if (perf.apiBase && perf.apiToken) {
            fetch(perf.apiBase + '/api/video-stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-zb-token': perf.apiToken },
              body: '{}'
            }).catch(function () {});
          }
        }
      });
    }
    // crossOrigin must be set BEFORE src for the canvas to stay untainted.
    video.crossOrigin = PREFER_STREAM ? 'anonymous' : null;
    var desired = PRIMARY_SRC;
    if (video.getAttribute('data-src') !== desired) {
      video.setAttribute('data-src', desired);
      video.src = desired;
    }
    // Autoplay policy: an unmuted video's play() is refused. Re-assert muted
    // right before every attempt, and try both immediately and on a timer (the
    // source may not have enough data on the first call).
    var tryPlay = function () {
      video.muted = MUTED;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    };
    tryPlay();
    if (!video.__zbPlayTimer) {
      video.__zbPlayTimer = setInterval(function () {
        // The layer hangs off documentElement (not body), so the reachability
        // check must not assume a body ancestor. While the window is hidden
        // the paused state is intentional (perf guard) — do not resume.
        if (!document.documentElement.contains(video)) { clearInterval(video.__zbPlayTimer); return; }
        if (video.paused && video.readyState >= 2 && !document.hidden) tryPlay();
      }, 700);
    }
  } else if (video) {
    video.remove();
    if (${JSON.stringify(Boolean(payload.wallpaperDataUri))}) {
      if (!wp) {
        wp = document.createElement('div');
        wp.id = MARKER + '-wallpaper';
        document.documentElement.appendChild(wp);
      }
      wp.style.backgroundImage = 'url(' + ${JSON.stringify(payload.wallpaperDataUri ?? "")} + ')';
    } else if (wp) {
      wp.remove();
    }
  } else if (${JSON.stringify(Boolean(payload.wallpaperDataUri))}) {
    if (!wp) {
      wp = document.createElement('div');
      wp.id = MARKER + '-wallpaper';
      document.documentElement.appendChild(wp);
    }
    wp.style.backgroundImage = 'url(' + ${JSON.stringify(payload.wallpaperDataUri ?? "")} + ')';
  } else if (wp) {
    wp.remove();
  }

  // --- web wallpaper layer (sandboxed iframe, topmost when set) ---------------
  var webifr = document.getElementById(MARKER + '-web');
  var WEB_URL = ${JSON.stringify(payload.webUrl ?? "")};
  if (WEB_URL) {
    // The video and still layers stand down (the payload suppresses both);
    // remove any lingering elements from earlier states.
    if (video) { video.remove(); video = null; }
    if (wp) { wp.remove(); wp = null; }
    if (!webifr) {
      webifr = document.createElement('iframe');
      webifr.id = MARKER + '-web';
      // allow-scripts: run the page's JS; allow-pointer-lock: interactive
      // wallpapers can grab the mouse. No allow-same-origin: the page gets a
      // unique opaque origin and cannot touch ZCode's own document or
      // storage. No top-navigation.
      webifr.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      webifr.setAttribute('referrerpolicy', 'no-referrer');
      document.documentElement.appendChild(webifr);
    }
    if (webifr.getAttribute('data-src') !== WEB_URL) {
      webifr.setAttribute('data-src', WEB_URL);
      webifr.src = WEB_URL;
    }
  } else if (webifr) {
    webifr.remove();
  }

  // --- perf guard hooks (attached once, read window.__zbPerf each event) ------
  if (!window.__zbPerfHooked) {
    window.__zbPerfHooked = true;
    // Pause video decoding while the window is hidden/occluded; the retry
    // timer resumes it when the window becomes visible again.
    document.addEventListener('visibilitychange', function () {
      var perf = window.__zbPerf || {};
      var v = document.getElementById('zcode-beautify-video');
      if (document.hidden && perf.pauseHidden && v && !v.paused) v.pause();
    });
    // Battery fallback: low + discharging → still image; back on AC → video.
    if (navigator.getBattery) {
      navigator.getBattery().then(function (b) {
        var check = function () {
          var perf = window.__zbPerf || {};
          if (!perf.apiBase || !perf.apiToken) return;
          var low = !b.charging && b.level < 0.2;
          var v = document.getElementById('zcode-beautify-video');
          var post = function (path, body) {
            return fetch(perf.apiBase + path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-zb-token': perf.apiToken },
              body: JSON.stringify(body || {})
            }).catch(function () {});
          };
          if (low && perf.batteryStill && v) {
            window.__zbBatteryStopped = true;
            post('/api/video-stop');
          } else if (!low && window.__zbBatteryStopped && perf.videoSourcePath) {
            window.__zbBatteryStopped = false;
            post('/api/wallpaper-path', { path: perf.videoSourcePath });
          }
        };
        b.addEventListener('levelchange', check);
        b.addEventListener('chargingchange', check);
        check();
      }).catch(function () {});
    }
  }

  var FIT = ${JSON.stringify(payload.fit ?? "cover")};
  var bp = document.getElementById(MARKER + '-backdrop');
  if (FIT === 'contain' && ${JSON.stringify(Boolean(payload.wallpaperDataUri))}) {
    if (!bp) {
      bp = document.createElement('div');
      bp.id = MARKER + '-backdrop';
      document.documentElement.appendChild(bp);
    }
    bp.style.backgroundImage = 'url(' + ${JSON.stringify(payload.wallpaperDataUri ?? "")} + ')';
    bp.dataset.on = '1';
  } else if (bp) {
    bp.dataset.on = '0';
  }

  // --- effects: parallax + particles -----------------------------------------
  var EFFECTS = ${JSON.stringify(payload.effects ?? { kenburns: false, parallax: false, particles: "none", intensity: 0.5 })};

  // Parallax: mouse position drives the --zb-par-x/y CSS vars with easing.
  if (window.__zbParHandler) { window.removeEventListener('mousemove', window.__zbParHandler); window.__zbParHandler = null; }
  if (window.__zbParRaf) { cancelAnimationFrame(window.__zbParRaf); window.__zbParRaf = null; }
  if (EFFECTS.parallax) {
    var par = { tx: 0, ty: 0, x: 0, y: 0 };
    var AMP = 16 * Math.max(0.2, Math.min(1, EFFECTS.intensity));
    window.__zbParHandler = function (e) {
      par.tx = (e.clientX / window.innerWidth - 0.5) * 2 * AMP;
      par.ty = (e.clientY / window.innerHeight - 0.5) * 2 * AMP;
      if (!window.__zbParRaf) {
        var step = function () {
          par.x += (par.tx - par.x) * 0.08;
          par.y += (par.ty - par.y) * 0.08;
          document.documentElement.style.setProperty('--zb-par-x', par.x.toFixed(2) + 'px');
          document.documentElement.style.setProperty('--zb-par-y', par.y.toFixed(2) + 'px');
          window.__zbParRaf = Math.abs(par.tx - par.x) > 0.1 || Math.abs(par.ty - par.y) > 0.1
            ? requestAnimationFrame(step) : null;
        };
        window.__zbParRaf = requestAnimationFrame(step);
      }
    };
    window.addEventListener('mousemove', window.__zbParHandler);
  } else {
    document.documentElement.style.removeProperty('--zb-par-x');
    document.documentElement.style.removeProperty('--zb-par-y');
  }

  // Particles: one canvas overlay, rAF physics, rebuilt when style changes.
  var canvas = document.getElementById(MARKER + '-particles');
  if (window.__zbParticlesStop) { window.__zbParticlesStop(); window.__zbParticlesStop = null; }
  if (canvas) { canvas.remove(); canvas = null; }
  if (EFFECTS.particles && EFFECTS.particles !== 'none') {
    canvas = document.createElement('canvas');
    canvas.id = MARKER + '-particles';
    document.documentElement.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var COUNT = Math.round(24 + 96 * Math.max(0, Math.min(1, EFFECTS.intensity)));
    var W = 0, H = 0;
    var resize = function () {
      W = canvas.width = Math.round(window.innerWidth * (window.devicePixelRatio || 1));
      H = canvas.height = Math.round(window.innerHeight * (window.devicePixelRatio || 1));
    };
    resize();
    window.addEventListener('resize', resize);
    var COLORS = {
      snow:   { colors: ['255,255,255', '224,236,255'], r: [1, 3.2], vy: [22, 70], sway: 26, spin: 0,  alpha: 0.85, rise: false },
      petals: { colors: ['255,183,197', '255,218,225', '244,143,177'], r: [2.5, 5], vy: [30, 80], sway: 40, spin: 2.2, alpha: 0.8, rise: false },
      light:  { colors: ['255,236,170', '255,244,214', '255,213,128'], r: [1.2, 3], vy: [14, 45], sway: 18, spin: 0,  alpha: 0.6, rise: true }
    }[EFFECTS.particles] || null;
    var parts = [];
    var spawn = function (initial) {
      var r = COLORS.r[0] + Math.random() * (COLORS.r[1] - COLORS.r[0]);
      return {
        x: Math.random() * W,
        y: initial ? Math.random() * H : (COLORS.rise ? H + r * 2 : -r * 2),
        r: r * (window.devicePixelRatio || 1),
        vy: (COLORS.vy[0] + Math.random() * (COLORS.vy[1] - COLORS.vy[0])) * (window.devicePixelRatio || 1),
        phase: Math.random() * Math.PI * 2,
        spin: Math.random() * Math.PI * 2,
        c: COLORS.colors[Math.floor(Math.random() * COLORS.colors.length)],
        a: COLORS.alpha * (0.5 + Math.random() * 0.5)
      };
    };
    for (var i = 0; i < COUNT; i++) parts.push(spawn(true));
    var last = performance.now();
    var frame = function (now) {
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      ctx.clearRect(0, 0, W, H);
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        p.phase += dt * 1.4;
        p.spin += dt * COLORS.spin;
        p.y += (COLORS.rise ? -p.vy : p.vy) * dt;
        p.x += Math.sin(p.phase) * COLORS.sway * dt * (window.devicePixelRatio || 1);
        if ((!COLORS.rise && p.y > H + p.r * 2) || (COLORS.rise && p.y < -p.r * 2)) parts[j] = spawn(false);
        ctx.save();
        ctx.globalAlpha = p.a;
        ctx.translate(p.x, p.y);
        ctx.rotate(COLORS.spin ? p.spin : 0);
        ctx.beginPath();
        if (EFFECTS.particles === 'petals') ctx.ellipse(0, 0, p.r * 1.6, p.r * 0.9, 0, 0, Math.PI * 2);
        else ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgb(' + p.c + ')';
        if (EFFECTS.particles === 'light') {
          ctx.shadowBlur = p.r * 6;
          ctx.shadowColor = 'rgb(' + p.c + ')';
        }
        ctx.fill();
        ctx.restore();
      }
      window.__zbParticlesRaf = requestAnimationFrame(frame);
    };
    window.__zbParticlesRaf = requestAnimationFrame(frame);
    window.__zbParticlesStop = function () {
      if (window.__zbParticlesRaf) cancelAnimationFrame(window.__zbParticlesRaf);
      window.removeEventListener('resize', resize);
    };
  }

  // --- video live color: sample frames, re-tint accent tokens -----------------
  if (window.__zbLiveColorTimer) { clearInterval(window.__zbLiveColorTimer); window.__zbLiveColorTimer = null; }
  if (PREFER_STREAM && VIDEO_URL && video) {
    var sample = function () {
      if (!document.documentElement.contains(video) || video.readyState < 2) return;
      var c = window.__zbSampleCanvas;
      if (!c) {
        c = window.__zbSampleCanvas = document.createElement('canvas');
        c.width = 48; c.height = 27;
      }
      var cx = c.getContext('2d', { willReadFrequently: true });
      try {
        cx.drawImage(video, 0, 0, 48, 27);
        var d = cx.getImageData(0, 0, 48, 27).data;
        var best = { sat: -1, r: 0, g: 0, b: 0 }, sr = 0, sg = 0, sb = 0;
        for (var k = 0; k < d.length; k += 4) {
          sr += d[k]; sg += d[k + 1]; sb += d[k + 2];
          var mx = Math.max(d[k], d[k + 1], d[k + 2]), mn = Math.min(d[k], d[k + 1], d[k + 2]);
          var v = mx / 255, s = mx === 0 ? 0 : (mx - mn) / mx;
          var score = s * (0.4 + 0.6 * v);
          if (score > best.sat) best = { sat: score, r: d[k], g: d[k + 1], b: d[k + 2] };
        }
        var n = d.length / 4;
        var avg = 'rgb(' + Math.round(sr / n) + ',' + Math.round(sg / n) + ',' + Math.round(sb / n) + ')';
        var accent = 'rgb(' + best.r + ',' + best.g + ',' + best.b + ')';
        var rootStyle = document.documentElement.style;
        rootStyle.setProperty('--color-primary', accent);
        rootStyle.setProperty('--color-brand', accent);
        rootStyle.setProperty('--color-accent', avg);
        rootStyle.setProperty('--color-input-border-focused', accent);
      } catch (e) { /* tainted canvas or no video yet: stay silent */ }
    };
    window.__zbLiveColorTimer = setInterval(sample, 5000);
    video.addEventListener('loadeddata', sample);
  } else {
    // Live color off: drop the inline overrides so stylesheet tokens rule again.
    var rootStyle2 = document.documentElement.style;
    rootStyle2.removeProperty('--color-primary');
    rootStyle2.removeProperty('--color-brand');
    rootStyle2.removeProperty('--color-accent');
    rootStyle2.removeProperty('--color-input-border-focused');
  }

  // Persist for the panel's self-heal path (best effort; large wallpapers may
  // exceed the localStorage quota, in which case only the CSS is saved).
  try {
    localStorage.setItem(MARKER + ':css', ${JSON.stringify(payload.css)});
    localStorage.setItem(MARKER + ':wallpaper', ${JSON.stringify(payload.wallpaperDataUri ?? "")});
    localStorage.setItem(MARKER + ':video', VIDEO_URL);
    localStorage.setItem(MARKER + ':web', WEB_URL);
  } catch (e) {}
})();`;
}

/** Removes everything the bootstrap script created. */
export function buildResetScript(marker = "zcode-beautify"): string {
  return `(function(){
  document.getElementById(${JSON.stringify(marker)} + '-style')?.remove();
  document.getElementById(${JSON.stringify(marker)} + '-wallpaper')?.remove();
  document.getElementById(${JSON.stringify(marker)} + '-video')?.remove();
  document.getElementById(${JSON.stringify(marker)} + '-web')?.remove();
  document.getElementById(${JSON.stringify(marker)} + '-backdrop')?.remove();
  try { localStorage.removeItem(${JSON.stringify(marker)} + ':video'); localStorage.removeItem(${JSON.stringify(marker)} + ':web'); } catch (e) {}
  if (window.__zcodeBeautify) { window.__zcodeBeautify.stateKey = null; }
})();`;
}
