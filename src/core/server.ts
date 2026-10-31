/**
 * `serve` mode: a localhost-only control API plus persistent injection
 * sessions.
 *
 * The injected settings panel (src/panel) talks to this API to read and change
 * the live configuration. Injection connections are held open so that
 * Page.addScriptToEvaluateOnNewDocument keeps re-running across renderer
 * reloads for as long as this process lives — no polling reinjection needed
 * while a session is healthy.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  CdpConnection,
  buildBootstrapScript,
  buildResetScript,
  listTargets,
  pickRendererTargets,
} from "./cdp.js";
import { buildPayload, DEFAULT_CONFIG, isVideoPath, type BeautifyConfig, type BuiltPayload, type EffectsConfig } from "./inject.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { scanLibrary, findItem, extractSceneStill, ensureWallpaperSized, thumbnailFor, libraryRoots, type LibraryItem } from "./library.js";
import { buildPanelScript, PANEL_ALIVE_ID, PANEL_BUILD } from "../panel/panelScript.js";
import { dataDir, isZcodeProcessRunning, loadConfig, relaunchZcode, saveConfig } from "./launch.js";
import { applyRecoveryMode, loadRecovery, normalizeMode } from "./recovery.js";
import { cliEntryPath, getAutostartStatus } from "./autostart.js";

const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_WALLPAPER_BYTES + 1024 * 1024;
const POLL_MS = 1500;

export interface ServeOptions {
  cdpPort: number;
  apiPort: number;
}

interface HeldSession {
  conn: CdpConnection;
  themeScriptId?: string;
}

/**
 * What the last poll saw. The panel has to tell three situations apart — healthy,
 * "ZCode is running but its debug port is closed", and "ZCode is not running" —
 * because each one asks the user for something different.
 */
interface RuntimeState {
  cdpReachable: boolean;
  rendererCount: number;
  zcodeRunning: boolean;
  lastError?: string;
  updatedAt?: string;
}

let runtimeState: RuntimeState = { cdpReachable: false, rendererCount: 0, zcodeRunning: false };

/** Update self-heal bookkeeping: when CDP went unreachable while ZCode runs. */
let unreachableSince = 0;
let cspHitAt = 0;
let repairInFlight = false;

/** Walking the process table on every failed poll would be wasteful. */
let nextProcessProbe = 0;

// One decoded image + extracted theme, reused across slider updates so the
// panel feels instant. Invalidated whenever the wallpaper file changes.
let cachedAssets: { file: string; mtimeMs: number; assets: WallpaperAssets } | undefined;

async function getAssets(wallpaperPath?: string): Promise<WallpaperAssets | undefined> {
  if (!wallpaperPath || !fs.existsSync(wallpaperPath)) return undefined;
  const mtimeMs = fs.statSync(wallpaperPath).mtimeMs;
  if (cachedAssets?.file === wallpaperPath && cachedAssets.mtimeMs === mtimeMs) {
    return cachedAssets.assets;
  }
  const assets = await loadWallpaper(wallpaperPath);
  cachedAssets = { file: wallpaperPath, mtimeMs, assets };
  return assets;
}

function currentConfig(): BeautifyConfig {
  return { ...DEFAULT_CONFIG, ...loadConfig() };
}

function backupFile(): string {
  return path.join(dataDir(), "config.backup.json");
}

function hasBackup(): boolean {
  return fs.existsSync(backupFile());
}

function publicConfig(config: BeautifyConfig) {
  return {
    blur: config.blur,
    dim: config.dim,
    monet: config.monet,
    wallpaperVisible: config.wallpaperVisible,
    fit: config.fit,
    wallpaperSet: Boolean(config.wallpaperPath && fs.existsSync(config.wallpaperPath)),
    videoSet: Boolean(config.videoPath && fs.existsSync(config.videoPath)),
    webSet: Boolean(config.webUrl),
    webUrl: config.webUrl,
    videoMuted: config.videoMuted !== false,
    videoLiveColor: Boolean(config.videoLiveColor),
    perfGuard: config.perfGuard ?? DEFAULT_CONFIG.perfGuard,
    currentPath: config.videoPath ?? config.wallpaperSource ?? config.wallpaperPath,
    effects: config.effects ?? DEFAULT_CONFIG.effects,
    playlist: config.playlist ?? [],
    favorites: config.favorites ?? [],
    rotateMin: config.rotateMin ?? 0,
    nightPath: config.nightPath,
    autoRepair: config.autoRepair !== false,
    hasBackup: hasBackup(),
    cdpPort: config.port,
  };
}

const PARTICLE_MODES = new Set(["none", "snow", "petals", "light"]);

function sanitizeEffects(body: any): EffectsConfig {
  const e = body?.effects ?? {};
  const base = DEFAULT_CONFIG.effects;
  return {
    kenburns: typeof e.kenburns === "boolean" ? e.kenburns : base.kenburns,
    parallax: typeof e.parallax === "boolean" ? e.parallax : base.parallax,
    particles: PARTICLE_MODES.has(e.particles) ? e.particles : base.particles,
    intensity: typeof e.intensity === "number" ? Math.max(0, Math.min(1, e.intensity)) : base.intensity,
  };
}

function sanitizeFavorites(body: any): string[] | undefined {
  if (!Array.isArray(body?.favorites)) return undefined;
  return body.favorites.filter((x: unknown) => typeof x === 'string').slice(0, 200);
}

function sanitizePlaylist(body: any): string[] | undefined {
  if (!Array.isArray(body?.playlist)) return undefined;
  return body.playlist
    .filter((p: unknown) => typeof p === "string" && p.trim() && fs.existsSync(p.trim().replace(/^"+|"+$/g, "")))
    .map((p: string) => p.trim().replace(/^"+|"+$/g, ""))
    .slice(0, 30);
}

function sanitize(body: any): Partial<BeautifyConfig> {
  const out: Partial<BeautifyConfig> = {};
  if (typeof body?.blur === "number" && body.blur >= 0 && body.blur <= 100) out.blur = body.blur;
  if (typeof body?.dim === "number" && body.dim >= 0 && body.dim <= 100) out.dim = body.dim;
  if (typeof body?.monet === "boolean") out.monet = body.monet;
  if (typeof body?.wallpaperVisible === "boolean") out.wallpaperVisible = body.wallpaperVisible;
  if (typeof body?.videoMuted === "boolean") out.videoMuted = body.videoMuted;
  if (typeof body?.videoLiveColor === "boolean") out.videoLiveColor = body.videoLiveColor;
  if (typeof body?.autoRepair === "boolean") out.autoRepair = body.autoRepair;
  if (typeof body?.webUrl === "string") {
    const wu = body.webUrl.trim().replace(/^"+|"+$/g, "");
    // Only real web pages: http(s) URLs, no exotic schemes.
    out.webUrl = /^https?:\/\//.test(wu) ? wu : undefined;
  }
  if (body?.perfGuard && typeof body.perfGuard === "object") {
    const pg = body.perfGuard;
    out.perfGuard = {
      pauseHidden: typeof pg.pauseHidden === "boolean" ? pg.pauseHidden : DEFAULT_CONFIG.perfGuard.pauseHidden,
      batteryStill: typeof pg.batteryStill === "boolean" ? pg.batteryStill : DEFAULT_CONFIG.perfGuard.batteryStill,
    };
  }
  if (body?.effects && typeof body.effects === "object") out.effects = sanitizeEffects(body);
  const playlist = sanitizePlaylist(body);
  if (playlist) out.playlist = playlist;
  const favorites = sanitizeFavorites(body);
  if (favorites) out.favorites = favorites;
  if (typeof body?.rotateMin === "number" && body.rotateMin >= 0 && body.rotateMin <= 240) out.rotateMin = Math.round(body.rotateMin);
  if (typeof body?.nightPath === "string") {
    const np = body.nightPath.trim().replace(/^"+|"+$/g, "");
    out.nightPath = np && fs.existsSync(np) ? np : undefined;
  }
  if (body?.fit === "cover" || body?.fit === "contain" || body?.fit === "smart") out.fit = body.fit;
  return out;
}

/** Media types handled by the wallpaper pipeline; the shared matcher lives in
 *  inject.ts (VIDEO_EXT) — this file only uses isVideoPath from there. */

// --- injection session management -------------------------------------------

const held = new Map<string, HeldSession>();

/** Injection payload + the loopback stream URL used when file:// video loading
 *  is refused by the host, or when canvas frame sampling needs CORS. */
function videoPayload(payload: BuiltPayload, apiPort: number, token: string, videoPath?: string) {
  return {
    css: payload.css,
    wallpaperDataUri: payload.wallpaperDataUri,
    fit: payload.fit,
    videoUrl: payload.videoUrl,
    videoMuted: payload.videoMuted,
    webUrl: payload.webUrl,
    videoLiveColor: payload.videoPreferStream,
    effects: payload.effects,
    perfGuard: payload.perfGuard,
    apiBase: `http://127.0.0.1:${apiPort}`,
    apiToken: token,
    videoSourcePath: videoPath,
    videoFallbackUrl:
      payload.videoUrl && videoPath
        ? `http://127.0.0.1:${apiPort}/api/video-stream?token=${encodeURIComponent(token)}&path=${encodeURIComponent(videoPath)}`
        : undefined,
  };
}

async function registerScript(
  session: HeldSession,
  source: string
): Promise<string> {
  const { identifier } = await session.conn.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return identifier;
}

async function holdSession(
  target: { id: string; webSocketDebuggerUrl?: string },
  config: BeautifyConfig,
  apiPort: number,
  token: string
): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
  // Anything that fails once the socket is up has to close it: the caller
  // retries every tick, so a connection dropped on the floor here would leave
  // one orphaned WebSocket per tick for as long as the failure lasts.
  try {
    await conn.send("Page.enable");
    const session: HeldSession = { conn };

    const assets = await getAssets(config.wallpaperPath);
    const payload = buildPayload(config, assets);
    const bootstrap = buildBootstrapScript(videoPayload(payload, apiPort, token, config.videoPath));
    const { identifier } = await conn.send("Page.addScriptToEvaluateOnNewDocument", {
      source: bootstrap,
    });
    session.themeScriptId = identifier;
    await conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });

    const panelScript = buildPanelScript(apiPort, token);
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: panelScript });
    await conn.send("Runtime.evaluate", { expression: panelScript, returnByValue: true });

    held.set(target.id, session);
  } catch (err) {
    conn.close();
    throw err;
  }
}

/** Re-runs the panel script on an already-held session (panel dropped by a
 *  page reload that kept the CDP target alive). */
async function reinjectPanel(session: HeldSession, apiPort: number, token: string): Promise<void> {
  const panelScript = buildPanelScript(apiPort, token);
  await session.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: panelScript });
  await session.conn.send("Runtime.evaluate", { expression: panelScript, returnByValue: true });
}

/** True while the panel's heartbeat marker is present in the page. A dead or
 *  unreachable session returns false so the self-heal drops it and the next
 *  poll re-holds the target afresh — that is what makes recovery self-driving. */
async function panelAlive(session: HeldSession): Promise<boolean> {
  try {
    const r = (await session.conn.send("Runtime.evaluate", {
      expression: `!!document.getElementById(${JSON.stringify(PANEL_ALIVE_ID)})`,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return r?.result?.value === true;
  } catch {
    return false; // unreachable page → the session is unusable; re-hold it
  }
}

/** Re-evaluates the theme bootstrap in every live session after a config change. */
async function pushConfigToSessions(config: BeautifyConfig, apiPort: number, token: string): Promise<number> {
  const assets = await getAssets(config.wallpaperPath);
  const payload = buildPayload(config, assets);
  const bootstrap = buildBootstrapScript(videoPayload(payload, apiPort, token, config.videoPath));
  let ok = 0;
  for (const [id, session] of held) {
    try {
      if (session.themeScriptId) {
        await session.conn
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId })
          .catch(() => {});
      }
      session.themeScriptId = await registerScript(session, bootstrap);
      await session.conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });
      ok++;
    } catch {
      session.conn.close();
      held.delete(id);
    }
  }
  return ok;
}

async function poll(config: BeautifyConfig, apiPort: number, token: string): Promise<void> {
  try {
    const targets = pickRendererTargets(await listTargets(config.port));
    const current = new Set(targets.map((t) => t.id));
    for (const t of targets) {
      if (!held.has(t.id)) {
        try {
          await holdSession(t, config, apiPort, token);
          console.log(`serve: panel + theme injected into "${t.title}" (${t.id})`);
        } catch (holdErr) {
          // A silent failure here would leave the daemon "alive but blind" —
          // the target never gets a panel and nothing in the log says why.
          console.log(`serve: holdSession failed for ${t.id}: ${(holdErr as Error).message}`);
        }
      }
    }
    for (const id of [...held.keys()]) {
      if (!current.has(id)) {
        held.get(id)!.conn.close();
        held.delete(id);
      }
    }
    // Self-heal: a page reload inside a still-alive target drops the injected
    // panel. Check each held session's heartbeat marker and re-inject when it
    // has gone missing, instead of waiting for a whole new target to appear.
    for (const [id, session] of [...held]) {
      if (!(await panelAlive(session))) {
        try {
          await reinjectPanel(session, apiPort, token);
          console.log(`serve: panel re-injected into ${id} (was dropped by a page reload)`);
        } catch {
          // The session itself is unusable: drop it, the next tick re-holds.
          session.conn.close();
          held.delete(id);
          console.log(`serve: dropped dead session ${id}; will re-hold next tick`);
        }
      }
    }
    runtimeState = {
      cdpReachable: true,
      rendererCount: targets.length,
      zcodeRunning: true,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    // No CDP endpoint: either ZCode is closed, or it is running without the
    // debug port. Either way the held sockets are dead weight — drop them so a
    // later restart injects afresh instead of matching a stale target id.
    for (const [id, session] of held) {
      session.conn.close();
      held.delete(id);
    }
    if (Date.now() > nextProcessProbe) {
      nextProcessProbe = Date.now() + 15_000;
      runtimeState = {
        cdpReachable: false,
        rendererCount: 0,
        zcodeRunning: await isZcodeProcessRunning(),
        lastError: (err as Error).message,
        updatedAt: new Date().toISOString(),
      };
    }
    // Update self-heal: a ZCode that is running but unreachable for over a
    // minute is the signature of a post-update launch without the debug flag.
    // With autoRepair on, the daemon restarts it from the fixed shortcut.
    if (runtimeState.zcodeRunning && config.autoRepair !== false) {
      if (!unreachableSince) unreachableSince = Date.now();
      if (Date.now() - unreachableSince > 60_000 && !repairInFlight) {
        repairInFlight = true;
        unreachableSince = 0;
        console.log(
          `serve: ZCode has been running without the debug port for over a minute — ` +
            `auto-repair (auto-restart with the flag) starting`
        );
        try {
          await relaunchZcode(config.port);
          console.log("serve: auto-repair restart done; re-injecting on the next poll");
        } catch (repairErr) {
          console.log(`serve: auto-repair failed: ${(repairErr as Error).message}`);
        } finally {
          repairInFlight = false;
        }
      }
    } else {
      unreachableSince = 0;
    }
  }
}

// --- HTTP API ----------------------------------------------------------------

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  // The client can vanish mid-request (panel closed, renderer reloaded); a
  // write to a dead socket must not escape as a rejection.
  try {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(body));
  } catch {
    /* response already finished or socket gone */
  }
}

/** Only the injected panel carries the token; nothing else on the machine has it. */
function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers["x-zb-token"];
  return typeof header === "string" && header.length > 0 && header === token;
}

/** True when another `serve` of this plugin already owns the port. */
export async function existingServePid(apiPort: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = (await res.json()) as { service?: string; pid?: number };
    return body?.service === "zcode-beautify" ? body.pid : undefined;
  } catch {
    return undefined;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

export async function startServe(opts: ServeOptions): Promise<void> {
  const { cdpPort, apiPort } = opts;

  // This API can replace the user's wallpaper and even relaunch ZCode, and it
  // answers anything that can reach localhost. The token only ever travels
  // inside the injected panel script, so a random web page cannot drive it.
  const token = randomBytes(16).toString("hex");

  // `serve --port N` must win over the port stored in the config file: reading
  // the merged config alone silently dialed the stored port while still
  // printing the flag's value.
  const runtimeConfig = (): BeautifyConfig => ({ ...currentConfig(), port: cdpPort });
  /** What actually goes to disk — the CLI's --port is not a persisted setting. */
  const persisted = (config: BeautifyConfig): BeautifyConfig => ({
    ...config,
    port: currentConfig().port,
  });

  const already = await existingServePid(apiPort);
  if (already !== undefined) {
    throw new Error(
      `a beautify service is already running on http://127.0.0.1:${apiPort} (pid ${already}) — ` +
        `open its panel, or stop that process first`
    );
  }

  // A request handler that rejects would otherwise take the whole process down
  // (unhandled rejection), killing every held injection session with it.
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        /* socket gone */
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      // /api/health stays open: it identifies the service but exposes nothing,
      // and the CLI relies on it to detect an already-running instance.
      // /api/video-stream and /api/thumb carry their token as a query
      // parameter — <video> and <img> elements cannot send custom headers.
      const queryTokenOk =
        (url.pathname === "/api/video-stream" || url.pathname === "/api/thumb") &&
        url.searchParams.get("token") === token;
      const devProbeOk = url.pathname === "/api/csp-test" || url.pathname === "/api/csp-hit";
      if (url.pathname !== "/api/health" && !devProbeOk && !queryTokenOk && !authorized(req, token)) {
        sendJson(res, 403, { error: "missing or invalid token" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, publicConfig(runtimeConfig()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const patch = sanitize(JSON.parse(await readBody(req)));
        const config = { ...runtimeConfig(), ...patch };
        saveConfig(persisted(config));
        const windows = await pushConfigToSessions(config, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(config) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/wallpaper") {
        const body = JSON.parse(await readBody(req));
        const dataUri = typeof body?.dataUri === "string" ? body.dataUri : "";
        const m = /^data:(image\/(?:jpeg|png|webp|gif|bmp));base64,(.+)$/.exec(dataUri);
        if (!m) throw new Error("dataUri must be a base64 image data URI");
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > MAX_WALLPAPER_BYTES) {
          throw new Error(`image too large (max ${MAX_WALLPAPER_BYTES / 1024 / 1024} MB)`);
        }
        const config = runtimeConfig();
        fs.mkdirSync(dataDir(), { recursive: true });
        const dest = path.join(dataDir(), "wallpaper" + IMAGE_EXT[m[1]]);
        fs.writeFileSync(dest, bytes);
        cachedAssets = { file: dest, mtimeMs: fs.statSync(dest).mtimeMs, assets: await loadWallpaper(dest) };
        // A data-URI upload has no original file; the copy in the data dir IS
        // the source of record.
        const next: BeautifyConfig = { ...runtimeConfig(), wallpaperPath: dest, wallpaperSource: dest, videoPath: undefined, webUrl: undefined };
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/wallpaper-path") {
        const body = JSON.parse(await readBody(req));
        const raw = typeof body?.path === "string" ? body.path.trim().replace(/^"+|"+$/g, "") : "";
        if (!raw) throw new Error("path is required");
        if (!fs.existsSync(raw)) throw new Error(`文件不存在: ${raw}`);
        if (fs.statSync(raw).isDirectory()) throw new Error("这是一个文件夹,不是媒体文件");

        // Video wallpapers are referenced in place (no copy — they are far too
        // large for the data directory) and replace the still image layer.
        if (isVideoPath(raw)) {
          const next: BeautifyConfig = { ...runtimeConfig(), videoPath: raw, videoMuted: true, webUrl: undefined };
          saveConfig(persisted(next));
          const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
          sendJson(res, 200, { ok: true, video: true, windows, ...publicConfig(next) });
          return;
        }

        // Oversized stills (8K extracts) are downscaled to 4K JPEG instead of
        // rejected — the injected layer is 2560px anyway.
        let importPath = raw;
        if (!isVideoPath(importPath)) importPath = await ensureWallpaperSized(importPath);
        const bytes = fs.readFileSync(importPath);
        if (bytes.length > MAX_WALLPAPER_BYTES) {
          throw new Error(`图片过大,上限 ${MAX_WALLPAPER_BYTES / 1024 / 1024} MB`);
        }
        const sig = bytes.subarray(0, 12);
        const isPng = sig.length >= 8 && sig.readUInt32BE(0) === 0x89504e47;
        const isJpg = sig.length >= 3 && sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff;
        const isGif = sig.length >= 6 && sig.toString("ascii", 0, 3) === "GIF";
        const isWebp = sig.length >= 12 && sig.toString("ascii", 0, 4) === "RIFF" && sig.toString("ascii", 8, 12) === "WEBP";
        const isBmp = sig.length >= 2 && sig.toString("ascii", 0, 2) === "BM";
        const mime = isPng ? "image/png" : isJpg ? "image/jpeg" : isGif ? "image/gif" : isWebp ? "image/webp" : isBmp ? "image/bmp" : null;
        if (!mime) throw new Error("不是可识别的媒体文件(图片: PNG/JPG/GIF/WebP/BMP; 视频: MP4/WebM/MOV)");
        const ext = "." + mime.split("/")[1].replace("jpeg", "jpg");
        const config = runtimeConfig();
        fs.mkdirSync(dataDir(), { recursive: true });
        const dest = path.join(dataDir(), "wallpaper" + ext);
        fs.writeFileSync(dest, bytes);
        cachedAssets = { file: dest, mtimeMs: fs.statSync(dest).mtimeMs, assets: await loadWallpaper(dest) };
        // A still image takes the visible layer back from any running video.
        const next: BeautifyConfig = { ...runtimeConfig(), wallpaperPath: dest, wallpaperSource: importPath, videoPath: undefined };
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      // Stops the web wallpaper and hands the visible layer back to the still
      // image (the image itself is untouched and stays as color source).
      if (req.method === "POST" && url.pathname === "/api/web-stop") {
        const next: BeautifyConfig = { ...runtimeConfig(), webUrl: undefined };
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      // Stops the video wallpaper and hands the visible layer back to the
      // still image (the image itself is untouched and stays as color source).
      if (req.method === "POST" && url.pathname === "/api/video-stop") {
        const config = runtimeConfig();
        const next: BeautifyConfig = { ...config, videoPath: undefined };
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      // Mute toggle. The panel click that calls this is a user gesture, so
      // unmuting is allowed by the autoplay policy.
      if (req.method === "POST" && url.pathname === "/api/video-mute") {
        const body = JSON.parse(await readBody(req));
        const config = runtimeConfig();
        const next: BeautifyConfig = { ...config, videoMuted: body?.muted !== false };
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      // Loopback video stream: fallback when the renderer refuses file://
      // subresource loads, and the hover-preview source for library videos.
      // A <video> element cannot send the token header, so the token travels
      // as a query parameter here. Any media file under a library root can be
      // streamed (token-gated + path-whitelisted).
      if (req.method === "GET" && url.pathname === "/api/video-stream") {
        const filePath = url.searchParams.get("path") ?? "";
        const allowed = libraryRoots();
        if (
          !filePath ||
          !isVideoPath(filePath) ||
          !fs.existsSync(filePath) ||
          !allowed.some((root) => filePath.startsWith(root))
        ) {
          sendJson(res, 404, { error: "no video to stream" });
          return;
        }
        const stat = fs.statSync(filePath);
        const type = filePath.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
        const range = req.headers.range;
        const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? Number(m[1]) : 0;
          const end = m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
          if (!Number.isFinite(start) || start > end || start >= stat.size) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return;
          }
          res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { ...base, "Content-Length": stat.size });
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const stored = loadConfig();
        // Back up the wallpaper config so /api/restore can bring it back
        // without re-importing the image.
        if (stored.wallpaperPath && fs.existsSync(stored.wallpaperPath)) {
          fs.mkdirSync(dataDir(), { recursive: true });
          fs.writeFileSync(backupFile(), JSON.stringify(stored));
        }
        for (const [id, session] of held) {
          try {
            if (session.themeScriptId) {
              await session.conn
                .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId })
                .catch(() => {});
              session.themeScriptId = undefined;
            }
            await session.conn.send("Runtime.evaluate", { expression: buildResetScript() });
          } catch {
            session.conn.close();
            held.delete(id);
          }
        }
        saveConfig({ ...stored, wallpaperPath: undefined, videoPath: undefined });
        cachedAssets = undefined;
        sendJson(res, 200, { ok: true, hasBackup: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/restore") {
        let saved: Partial<BeautifyConfig>;
        try {
          saved = JSON.parse(fs.readFileSync(backupFile(), "utf8"));
        } catch {
          throw new Error("no wallpaper backup available");
        }
        const config: BeautifyConfig = { ...DEFAULT_CONFIG, ...saved };
        saveConfig(config);
        const windows = await pushConfigToSessions(config, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(config) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, {
          ...runtimeState,
          recovery: loadRecovery(),
          autostart: getAutostartStatus(),
        });
        return;
      }

      // --- wallpaper library ----------------------------------------------------
      if (req.method === "GET" && url.pathname === "/api/library") {
        const items = scanLibrary();
        sendJson(res, 200, {
          roots: libraryRoots(),
          items: items.map((i) => ({
            id: i.id,
            title: i.title,
            type: i.type,
            thumbUrl: i.thumbPath
              ? `/api/thumb?token=${encodeURIComponent(token)}&path=${encodeURIComponent(i.thumbPath)}`
              : undefined,
            dims: i.dims,
            // Hover preview: images get a larger thumbnail, videos play the
            // loopback stream directly.
            previewUrl: i.thumbPath
              ? `/api/thumb?size=800&token=${encodeURIComponent(token)}&path=${encodeURIComponent(i.thumbPath)}`
              : undefined,
            streamUrl:
              i.type === "video" && i.mediaPath
                ? `/api/video-stream?token=${encodeURIComponent(token)}&path=${encodeURIComponent(i.mediaPath)}`
                : undefined,
          })),
        });
        return;
      }

      // Thumbnails are served from a whitelist of library roots plus the
      // plugin data dir (the current-wallpaper copy lives there).
      if (req.method === "GET" && url.pathname === "/api/thumb") {
        const thumbPath = url.searchParams.get("path") ?? "";
        const allowed = [...libraryRoots(), dataDir()];
        if (!thumbPath || !allowed.some((r) => thumbPath.startsWith(r))) {
          sendJson(res, 403, { error: "path outside library roots" });
          return;
        }
        const sizeParam = Number(url.searchParams.get("size") ?? 320);
        const size = [320, 800].includes(sizeParam) ? sizeParam : 320;
        const cached = await thumbnailFor(thumbPath, size);
        if (!cached) {
          sendJson(res, 404, { error: "no thumbnail" });
          return;
        }
        const data = fs.readFileSync(cached);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": data.length,
          "Cache-Control": "max-age=3600",
        });
        res.end(data);
        return;
      }

      // Apply a library item. Scene items get their still background extracted
      // from scene.pkg on first use (cached in the library cache dir).
      if (req.method === "POST" && url.pathname === "/api/library-apply") {
        const body = JSON.parse(await readBody(req));
        const item: LibraryItem | undefined = findItem(String(body?.id ?? ""));
        if (!item) throw new Error("壁纸库里没有这个项目");
        let mediaPath = item.mediaPath;
        if (item.type === "scene") {
          mediaPath = extractSceneStill(item);
          if (!mediaPath) throw new Error("场景背景提取失败（pkg 里没有可用的内嵌图）");
        }
        if (!mediaPath || !fs.existsSync(mediaPath)) throw new Error("媒体文件不存在");
        if (!isVideoPath(mediaPath)) mediaPath = await ensureWallpaperSized(mediaPath);
        let next: BeautifyConfig;
        if (item.type === "video" || isVideoPath(mediaPath)) {
          next = { ...runtimeConfig(), videoPath: mediaPath, videoMuted: true };
        } else {
          const bytes = fs.readFileSync(mediaPath);
          if (bytes.length > MAX_WALLPAPER_BYTES) {
            throw new Error(`图片过大,上限 ${MAX_WALLPAPER_BYTES / 1024 / 1024} MB`);
          }
          fs.mkdirSync(dataDir(), { recursive: true });
          const dest = path.join(dataDir(), "wallpaper" + path.extname(mediaPath).toLowerCase());
          fs.writeFileSync(dest, bytes);
          cachedAssets = { file: dest, mtimeMs: fs.statSync(dest).mtimeMs, assets: await loadWallpaper(dest) };
          next = { ...runtimeConfig(), wallpaperPath: dest, wallpaperSource: mediaPath, videoPath: undefined, webUrl: undefined };
        }
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      // --- wallpaper library (end) ----------------------------------------------

      // --- appearance presets ---------------------------------------------------
      // A preset snapshots the whole look: wallpaper source, video, effects and
      // tuning. Stored in a separate file so config.json stays lean.
      function presetsFile(): string {
        return path.join(dataDir(), "presets.json");
      }
      interface Preset {
        name: string;
        savedAt: string;
        cfg: Partial<BeautifyConfig>;
      }
      function loadPresets(): Preset[] {
        try {
          return JSON.parse(fs.readFileSync(presetsFile(), "utf8")).presets ?? [];
        } catch {
          return [];
        }
      }
      function savePresets(list: Preset[]): void {
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(presetsFile(), JSON.stringify({ presets: list }, null, 2));
      }
      const PRESET_FIELDS = [
        "wallpaperSource", "videoPath", "videoMuted", "videoLiveColor",
        "effects", "perfGuard", "blur", "dim", "monet", "wallpaperVisible", "fit",
      ] as const;

      if (req.method === "GET" && url.pathname === "/api/presets") {
        sendJson(res, 200, { presets: loadPresets() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/presets-save") {
        const body = JSON.parse(await readBody(req));
        const name = String(body?.name ?? "").trim();
        if (!name) throw new Error("请先给快照起个名字");
        const config = runtimeConfig();
        const cfg: Partial<BeautifyConfig> = {};
        for (const f of PRESET_FIELDS) (cfg as unknown as Record<string, unknown>)[f] = (config as unknown as Record<string, unknown>)[f];
        const list = loadPresets().filter((x) => x.name !== name);
        list.push({ name, savedAt: new Date().toISOString(), cfg });
        savePresets(list);
        sendJson(res, 200, { ok: true, presets: loadPresets() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/presets-del") {
        const body = JSON.parse(await readBody(req));
        const name = String(body?.name ?? "");
        savePresets(loadPresets().filter((x) => x.name !== name));
        sendJson(res, 200, { ok: true, presets: loadPresets() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/presets-apply") {
        const body = JSON.parse(await readBody(req));
        const preset = loadPresets().find((x) => x.name === String(body?.name ?? ""));
        if (!preset) throw new Error("快照不存在");
        const config = runtimeConfig();
        const next: BeautifyConfig = { ...config, ...preset.cfg };
        // Videos are referenced by path; re-check it still exists.
        if (next.videoPath && !fs.existsSync(next.videoPath)) next.videoPath = undefined;
        if (!next.videoPath) {
          const src = next.wallpaperSource;
          if (!src || !fs.existsSync(src)) throw new Error("快照里的壁纸文件已丢失");
          if (!isVideoPath(src)) {
            const bytes = fs.readFileSync(src);
            if (bytes.length > MAX_WALLPAPER_BYTES) {
              const fixed = await ensureWallpaperSized(src);
              next.wallpaperSource = fixed;
            }
          }
        }
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      // --- appearance presets (end) ----------------------------------------------

      if (req.method === "POST" && url.pathname === "/api/relaunch") {
        const result = await relaunchZcode(cdpPort);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/recovery") {
        const body = JSON.parse(await readBody(req));
        const mode = normalizeMode(body?.mode);
        if (!mode) throw new Error("mode must be one of: off, on-start, always");
        const status = applyRecoveryMode(mode, {
          nodePath: process.execPath,
          cliPath: cliEntryPath(),
          cdpPort,
          apiPort,
        });
        sendJson(res, 200, {
          ok: true,
          recovery: { mode: status.mode, updatedAt: status.updatedAt },
          autostart: status.autostart,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, service: "zcode-beautify", pid: process.pid, cspHit: cspHitAt });
        return;
      }

      // TEMP: CSP probe for iframe embedding (dev aid, remove after verification)
      if (req.method === "GET" && url.pathname === "/api/csp-test") { // auth-exempt dev probe
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end('<script>fetch("/api/csp-hit").catch(function(){});</script>');
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/csp-hit") { // auth-exempt dev probe
        cspHitAt = Date.now();
        res.writeHead(204); res.end();
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(apiPort, "127.0.0.1", resolve);
  });

  // The listen-time listener above is one-shot; without a permanent one, any
  // later server error would be an unhandled 'error' event and crash serve.
  server.on("error", (err) => {
    console.error(`serve: http server error — ${(err as Error).message}`);
  });

  console.log(`serve: control API on http://127.0.0.1:${apiPort} — Ctrl+C to stop`);
  console.log(`serve: injecting into ZCode renderers on CDP port ${cdpPort}`);

  // Wallpaper rotation + night wallpaper, checked once a minute.
  let rotateIdx = 0;
  let lastRotateAt = 0;
  let preNightPath: string | undefined;
  const carouselTick = async () => {
    const config = runtimeConfig();
    try {
      const hour = new Date().getHours();
      const nightNow = hour >= 19 || hour < 7;
      const nightWanted =
        nightNow && config.nightPath && fs.existsSync(config.nightPath) ? config.nightPath : undefined;
      if (nightWanted && nightWanted !== config.wallpaperPath) {
        if (!preNightPath) preNightPath = config.wallpaperPath;
        const next: BeautifyConfig = { ...config, wallpaperPath: nightWanted, videoPath: undefined };
        saveConfig(persisted(next));
        await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        console.log(`serve: night wallpaper applied (${path.basename(nightWanted)})`);
        return;
      }
      if (!nightNow && preNightPath && config.wallpaperPath === config.nightPath) {
        const back = preNightPath;
        preNightPath = undefined;
        if (back && fs.existsSync(back)) {
          const next: BeautifyConfig = { ...config, wallpaperPath: back };
          saveConfig(persisted(next));
          await pushConfigToSessions(next, apiPort, token).catch(() => 0);
          console.log(`serve: night over — restored ${path.basename(back)}`);
        }
        return;
      }
      if (config.rotateMin > 0 && (config.playlist?.length ?? 0) > 1 && !nightWanted) {
        if (!lastRotateAt) { lastRotateAt = Date.now(); return; }
        if (Date.now() - lastRotateAt < config.rotateMin * 60_000) return;
        lastRotateAt = Date.now();
        rotateIdx = (rotateIdx + 1) % config.playlist.length;
        const p = config.playlist[rotateIdx];
        if (!fs.existsSync(p)) return;
        const next: BeautifyConfig = isVideoPath(p)
          ? { ...config, videoPath: p, videoMuted: true }
          : { ...config, wallpaperPath: p, videoPath: undefined };
        saveConfig(persisted(next));
        await pushConfigToSessions(next, apiPort, token).catch(() => 0);
        console.log(`serve: rotated wallpaper -> ${path.basename(p)}`);
      }
    } catch {
      /* a broken playlist entry must not take the daemon down */
    }
  };
  setInterval(() => void carouselTick(), 30_000);

  // Initial pass, then keep polling so restarts of the app get re-injected.
  // The loop must survive everything: a dead poll leaves the daemon alive but
  // blind, which is the worst failure mode this service can be in.
  await poll(runtimeConfig(), apiPort, token);
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      await poll(runtimeConfig(), apiPort, token);
    } catch (pollErr) {
      console.error(`serve: poll error (loop continues) — ${(pollErr as Error).message}`);
    }
  }
}
