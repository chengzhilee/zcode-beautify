/**
 * Shared high-level operations used by both the CLI and the MCP server.
 */

import fs from "node:fs";
import path from "node:path";
import { applyToZCode, buildPayload, DEFAULT_CONFIG, isVideoPath, loadWallpaper, resetZCode, type BeautifyConfig, type BuiltPayload } from "./inject.js";
import { dataDir, loadConfig, saveConfig } from "./launch.js";

export interface ApplyOptions {
  port?: number;
  blur?: number;
  dim?: number;
  monet?: boolean;
  wallpaperVisible?: boolean;
  fit?: "cover" | "contain" | "smart";
  kenburns?: boolean;
  parallax?: boolean;
  particles?: "none" | "snow" | "petals" | "light";
  intensity?: number;
}

function effectsFromOpts(opts: ApplyOptions, stored: Partial<BeautifyConfig>) {
  const base = { ...DEFAULT_CONFIG.effects, ...(stored.effects ?? {}) };
  return {
    ...base,
    ...(opts.kenburns !== undefined ? { kenburns: opts.kenburns } : {}),
    ...(opts.parallax !== undefined ? { parallax: opts.parallax } : {}),
    ...(opts.particles !== undefined ? { particles: opts.particles } : {}),
    ...(opts.intensity !== undefined ? { intensity: opts.intensity } : {}),
  };
}

/** Applies (or refreshes) the theme using the stored config. */
export async function reapplyStored(): Promise<number> {
  const config = mergedConfig();
  return applyToZCode(config, await buildPayloadFromConfig(config));
}

export async function applyWallpaper(imagePath: string, opts: ApplyOptions): Promise<{ windows: number; config: BeautifyConfig }> {
  const abs = path.resolve(imagePath);
  if (!fs.existsSync(abs)) throw new Error(`Image not found: ${abs}`);

  const stored = loadConfig();
  const config: BeautifyConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    port: opts.port ?? stored.port ?? DEFAULT_CONFIG.port,
    blur: opts.blur ?? stored.blur ?? DEFAULT_CONFIG.blur,
    dim: opts.dim ?? stored.dim ?? DEFAULT_CONFIG.dim,
    monet: opts.monet ?? stored.monet ?? DEFAULT_CONFIG.monet,
    wallpaperVisible: opts.wallpaperVisible ?? stored.wallpaperVisible ?? DEFAULT_CONFIG.wallpaperVisible,
    fit: opts.fit ?? stored.fit ?? DEFAULT_CONFIG.fit,
  };

  // A video wallpaper is referenced in place: copying hundreds of MB into the
  // data dir would be pointless, and Monet colors stay tied to the stored
  // still image (which survives as the color source).
  if (isVideoPath(abs)) {
    const videoConfig: BeautifyConfig = { ...config, videoPath: abs, videoMuted: config.videoMuted ?? true, webUrl: undefined };
    saveConfig(videoConfig);
    const videoAssets =
      videoConfig.wallpaperPath && fs.existsSync(videoConfig.wallpaperPath)
        ? await loadWallpaper(videoConfig.wallpaperPath)
        : undefined;
    const windows = await applyToZCode(videoConfig, buildPayload(videoConfig, videoAssets));
    return { windows, config: videoConfig };
  }

  // Keep a copy of the wallpaper inside the data dir so the theme survives
  // the original file being moved/deleted.
  fs.mkdirSync(dataDir(), { recursive: true });
  const dest = path.join(dataDir(), "wallpaper" + path.extname(abs).toLowerCase());
  if (dest !== abs) fs.copyFileSync(abs, dest);

  const assets = await loadWallpaper(dest);
  const payload = buildPayload(config, assets);
  // Persist first: even if the app is not running yet, `launch` + `refresh_theme`
  // can pick the stored theme up later.
  saveConfig({ ...config, wallpaperPath: dest, wallpaperSource: abs, videoPath: undefined, webUrl: undefined });

  const windows = await applyToZCode(config, payload);
  return { windows, config };
}

export async function applyColorsOnly(opts: ApplyOptions): Promise<number> {
  const stored = loadConfig();
  const config: BeautifyConfig = {
    ...DEFAULT_CONFIG,
    ...stored,
    port: opts.port ?? stored.port ?? DEFAULT_CONFIG.port,
    blur: opts.blur ?? stored.blur ?? DEFAULT_CONFIG.blur,
    dim: opts.dim ?? stored.dim ?? DEFAULT_CONFIG.dim,
    monet: opts.monet ?? stored.monet ?? DEFAULT_CONFIG.monet,
    wallpaperVisible: opts.wallpaperVisible ?? stored.wallpaperVisible ?? DEFAULT_CONFIG.wallpaperVisible,
    fit: opts.fit ?? stored.fit ?? DEFAULT_CONFIG.fit,
    effects: effectsFromOpts(opts, stored),
  };
  saveConfig(config);
  return applyToZCode(config, await buildPayloadFromConfig(config));
}

export async function resetAppearance(port?: number): Promise<number> {
  const stored = loadConfig();
  await resetZCode(port ?? stored.port ?? DEFAULT_CONFIG.port);
  saveConfig({ ...stored, wallpaperPath: undefined, videoPath: undefined, webUrl: undefined });
  return 0;
}

export async function buildPayloadFromConfig(config: BeautifyConfig): Promise<BuiltPayload> {
  let assets;
  if (config.wallpaperPath && fs.existsSync(config.wallpaperPath)) {
    assets = await loadWallpaper(config.wallpaperPath);
  }
  return buildPayload(config, assets);
}

function mergedConfig(): BeautifyConfig {
  return { ...DEFAULT_CONFIG, ...loadConfig(), port: loadConfig().port ?? DEFAULT_CONFIG.port };
}
