/**
 * Assembles the full injected payload: wallpaper layer CSS + variable
 * overrides, plus helpers to apply a theme to a running ZCode instance.
 */

import path from "node:path";
import { CdpConnection, injectIntoTarget, listTargets, pickRendererTargets, buildResetScript } from "./cdp.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildVariableOverrides, buildTransparencyOverrides } from "./tokens.js";

export type WallpaperFit = "cover" | "contain" | "smart";

/** Performance guard switches (all automatic, panel-togglable). */
export interface PerfGuardConfig {
  /** Pause video decoding while the window is hidden/occluded. */
  pauseHidden: boolean;
  /** Switch to the still image when the battery runs low, restore on AC. */
  batteryStill: boolean;
}

export const DEFAULT_PERF_GUARD: PerfGuardConfig = { pauseHidden: true, batteryStill: true };

/** Pseudo-dynamic effects layered onto the still wallpaper (and parallax +
 *  particles onto video too). All cheap CSS/canvas, no re-encoding. */
export interface EffectsConfig {
  /** Slow Ken Burns drift on the still image (background-size/position). */
  kenburns: boolean;
  /** Mouse-follow parallax (CSS vars, applies to image and video layers). */
  parallax: boolean;
  /** Canvas particle overlay style. */
  particles: "none" | "snow" | "petals" | "light";
  /** 0-1: particle count + motion amplitude. */
  intensity: number;
}

export const DEFAULT_EFFECTS: EffectsConfig = {
  kenburns: false,
  parallax: false,
  particles: "none",
  intensity: 0.5,
};

/** Extensions handled as video wallpapers (lowercase, with dot). */
export const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);

export function isVideoPath(p: string): boolean {
  return VIDEO_EXT.has(path.extname(p).toLowerCase());
}

export interface BeautifyConfig {
  port: number;
  wallpaperPath?: string;
  /** Where the still image came from (data-dir copies collapse onto one name,
   *  so playlist entries must reference the original file). */
  wallpaperSource?: string;
  /** Video wallpaper; when set it replaces the still image as the visible layer. */
  videoPath?: string;
  /** Video starts muted (browsers require it for autoplay). */
  videoMuted?: boolean;
  /** Sample video frames and re-tint UI accents while the video plays. */
  videoLiveColor?: boolean;
  /** Web page wallpaper (http/https URL) — topmost layer when set. */
  webUrl?: string;
  /** Performance guard switches. */
  perfGuard: PerfGuardConfig;
  /** Pseudo-dynamic effects on the wallpaper layers. */
  effects: EffectsConfig;
  /** Wallpaper rotation playlist (paths); empty = off. */
  playlist: string[];
  /** Library item ids starred in the wallpaper library (sorted first there). */
  favorites: string[];
  /** Minutes between playlist rotations; 0 = off. */
  rotateMin: number;
  /** Wallpaper applied automatically between 19:00 and 07:00; empty = off. */
  nightPath?: string;
  /** Daemon auto-restarts ZCode (with the flag) when it detects the app
   *  running without the debug port for over a minute. */
  autoRepair: boolean;
  blur: number;
  dim: number;
  monet: boolean;
  wallpaperVisible: boolean;
  fit: WallpaperFit;
}

export const DEFAULT_CONFIG: BeautifyConfig = {
  port: 9222,
  videoMuted: true,
  videoLiveColor: false,
  perfGuard: DEFAULT_PERF_GUARD,
  effects: DEFAULT_EFFECTS,
  playlist: [],
  favorites: [],
  rotateMin: 0,
  autoRepair: true,
  blur: 0,
  dim: 25,
  monet: true,
  wallpaperVisible: true,
  fit: "cover",
};

export interface BuiltPayload {
  css: string;
  wallpaperDataUri?: string;
  /** file:// URL of the video wallpaper, when one is set. */
  videoUrl?: string;
  videoMuted: boolean;
  /** Force the loopback stream as the primary video source (needed for
   *  canvas frame sampling: file:// frames taint the canvas). */
  videoPreferStream: boolean;
  effects: EffectsConfig;
  perfGuard: PerfGuardConfig;
  /** Loopback API base + token so the injected script can call video-stop /
   *  wallpaper-path on its own (battery fallback, codec degrade). */
  apiBase?: string;
  apiToken?: string;
  /** Filesystem path of the current video (battery-restore re-apply). */
  videoSourcePath?: string;
  /** Web page wallpaper URL (sandboxed iframe layer, topmost when set). */
  webUrl?: string;
  /** How the wallpaper layer is framed; "contain" adds a blurred backdrop. */
  fit: "cover" | "contain";
  /** Normalized focus point for background-position. */
  focusX: number;
  focusY: number;
}

/** Local Windows path → file:// URL usable as a media element source. */
export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : "/" + normalized;
  return "file://" + withSlash.split("/").map(encodeURIComponent).join("/").replace(/^%2F/, "/");
}

export function buildPayload(config: BeautifyConfig, assets?: WallpaperAssets): BuiltPayload {
  const parts: string[] = [];

  // "smart" resolves to the analyzed suggestion at build time, so the injected
  // CSS only ever deals with cover or contain.
  const resolved: "cover" | "contain" =
    config.fit === "smart" ? (assets?.focus.fit ?? "cover") : config.fit === "contain" ? "contain" : "cover";
  const focusX = config.fit === "smart" ? (assets?.focus.x ?? 0.5) : 0.5;
  const focusY = config.fit === "smart" ? (assets?.focus.y ?? 0.5) : 0.5;
  const position = `${Math.round(focusX * 100)}% ${Math.round(focusY * 100)}%`;

  parts.push(`
html, body { background: transparent !important; }
#zcode-beautify-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -2147483646;
  background-size: ${resolved};
  background-position: ${resolved === "contain" ? "center" : position};
  background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(${config.blur}px);
  transform: translate3d(var(--zb-par-x, 0px), var(--zb-par-y, 0px), 0) scale(${config.blur > 0 ? 1.04 : 1});
  will-change: transform;
}
${config.effects.kenburns && !config.videoPath ? `
@keyframes zb-kenburns {
  0%   { background-size: ${resolved === "contain" ? "auto 92%" : "100% auto"}; background-position: ${resolved === "contain" ? "center 40%" : "50% 50%"}; }
  100% { background-size: ${resolved === "contain" ? "auto 98%" : "106% auto"}; background-position: ${resolved === "contain" ? "center 60%" : "52% 48%"}; }
}
#zcode-beautify-wallpaper { animation: zb-kenburns 44s ease-in-out infinite alternate; }` : ""}
#zcode-beautify-video {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -2147483646;
  object-fit: ${resolved};
  pointer-events: none;
  background: #000;
  filter: blur(${config.blur}px) brightness(${Math.max(0.2, 1 - config.dim / 100)});
  transform: translate3d(var(--zb-par-x, 0px), var(--zb-par-y, 0px), 0) scale(${config.blur > 0 ? 1.04 : 1});
  will-change: transform;
}
#zcode-beautify-particles {
  position: fixed;
  inset: 0;
  z-index: -2147483645;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
#zcode-beautify-web {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -2147483646;
  border: 0;
  pointer-events: none;
  background: #000;
  filter: blur(${config.blur}px) brightness(${Math.max(0.2, 1 - config.dim / 100)});
  transform: translate3d(var(--zb-par-x, 0px), var(--zb-par-y, 0px), 0) scale(${config.blur > 0 ? 1.04 : 1});
}
#zcode-beautify-backdrop {
  position: fixed;
  inset: 0;
  z-index: -2147483647;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(28px) saturate(1.15) brightness(0.85);
  transform: scale(1.12);
  display: none;
}
#zcode-beautify-backdrop[data-on="1"] { display: block; }`);
  if (config.dim > 0) {
    parts.push(`#zcode-beautify-wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / var(--zcode-beautify-dim, ${config.dim / 100}));
}`);
  }

  if (assets) {
    // Monet recolors the UI from the wallpaper; the wallpaper toggle only
    // decides whether the picture is visible at all. With Monet off we still
    // need transparency, otherwise the opaque UI hides the wallpaper.
    if (config.monet) {
      parts.push(buildVariableOverrides(assets.theme, {
        dim: config.dim,
        wallpaperVisible: config.wallpaperVisible,
      }));
    } else if (config.wallpaperVisible) {
      parts.push(buildTransparencyOverrides({ dim: config.dim }));
    }
  }
  // A video wallpaper replaces the still image as the visible layer, but the
  // image (if any) stays as the Monet color source.
  const videoUrl = config.videoPath ? pathToFileUrl(config.videoPath) : undefined;
  const wallpaperDataUri = config.wallpaperVisible && !videoUrl ? assets?.dataUri : undefined;
  // Canvas frame sampling taints on file:// sources, so live color requires
  // the CORS-enabled loopback stream as the primary source.
  const videoPreferStream = Boolean(videoUrl && config.videoLiveColor);
  // A web wallpaper replaces both the video and still layers visually; the
  // still image keeps serving as the Monet color source.
  const webUrl = config.webUrl;
  const visibleDataUri = webUrl ? undefined : wallpaperDataUri;
  const visibleVideoUrl = webUrl ? undefined : videoUrl;

  return {
    css: parts.join("\n"),
    wallpaperDataUri: visibleDataUri,
    webUrl,
    videoUrl: visibleVideoUrl,
    videoMuted: config.videoMuted !== false,
    videoPreferStream,
    effects: config.effects ?? DEFAULT_EFFECTS,
    perfGuard: config.perfGuard ?? DEFAULT_PERF_GUARD,
    fit: config.wallpaperVisible ? resolved : "cover",
    focusX,
    focusY,
  };
}

/** Apply config to a running ZCode instance. Returns how many windows got it. */
export async function applyToZCode(config: BeautifyConfig, payload: BuiltPayload): Promise<number> {
  const targets = pickRendererTargets(await listTargets(config.port));
  if (targets.length === 0) {
    throw new Error("No ZCode renderer target found on the CDP endpoint.");
  }
  let count = 0;
  for (const target of targets) {
    try {
      await injectIntoTarget(target, payload);
      count++;
    } catch (err) {
      console.warn(`Injection into "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

export async function resetZCode(port: number): Promise<number> {
  const targets = pickRendererTargets(await listTargets(port));
  let count = 0;
  for (const target of targets) {
    try {
      const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
      await conn.send("Runtime.evaluate", { expression: buildResetScript() });
      conn.close();
      count++;
    } catch (err) {
      console.warn(`Reset of "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

/** Re-export so CLI/MCP can load wallpapers without touching monet internals. */
export { loadWallpaper };
