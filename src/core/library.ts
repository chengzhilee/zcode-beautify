/**
 * Wallpaper library: scans Steam workshop items and the local wallpapers
 * folder, serves cached thumbnails, and lazily extracts a still background
 * from scene-type items (the WE .pkg parsing proven on 长安雪 / ATRI).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Jimp, JimpMime } from "jimp";
import { isVideoPath } from "./inject.js";
import { dataDir } from "./launch.js";

export interface LibraryItem {
  /** Stable id: "ws-<workshopid>" or "my-<basename>". */
  id: string;
  title: string;
  /** video = directly usable media file; scene = needs still extraction. */
  type: "video" | "image" | "scene";
  /** Path handed to the wallpaper pipeline (video/image items only). */
  mediaPath?: string;
  /** Absolute path of a cached extracted still (scene items, once extracted). */
  stillPath?: string;
  /** Source folder of the item (scene pkg lives here). */
  itemDir?: string;
  thumbPath: string;
  /** Pixel dimensions of the applicable still (images and extracted scenes). */
  dims?: { w: number; h: number };
}

/** Reads image dimensions from file headers only — no full decode. Supports
 *  PNG (IHDR), GIF (header) and JPEG (SOF marker scan in the first 64 KB). */
export function readImageDims(p: string): { w: number; h: number } | undefined {
  try {
    const fd = fs.openSync(p, "r");
    const head = Buffer.alloc(32);
    const headRead = fs.readSync(fd, head, 0, 32, 0);
    let result: { w: number; h: number } | undefined;
    if (headRead >= 24 && head.readUInt32BE(0) === 0x89504e47) {
      result = { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
    } else if (headRead >= 10 && head.toString("ascii", 0, 3) === "GIF") {
      result = { w: head.readUInt16LE(6), h: head.readUInt16LE(8) };
    } else if (headRead >= 3 && head[0] === 0xff && head[1] === 0xd8) {
      const buf = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      let i = 2;
      while (i + 9 < bytesRead) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          result = { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
          break;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const seg = buf.readUInt16BE(i + 2);
        if (seg < 2) break;
        i += 2 + seg;
      }
    }
    fs.closeSync(fd);
    return result;
  } catch {
    return undefined;
  }
}

const WORKSHOP_CANDIDATES = [
  process.env.STEAM_LIBRARY
    ? path.join(process.env.STEAM_LIBRARY, "steamapps", "workshop", "content", "431960")
    : undefined,
  "D:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960",
  "C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960",
  path.join(os.homedir(), "AppData", "Local", "Programs", "Steam", "steamapps", "workshop", "content", "431960"),
].filter((p): p is string => Boolean(p));

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function libraryRoots(): string[] {
  const roots = WORKSHOP_CANDIDATES.filter((p) => fs.existsSync(p));
  // The user's own stills/videos live beside the plugin's other data.
  const mine = path.join(dataDir(), "wallpapers");
  fs.mkdirSync(mine, { recursive: true });
  roots.push(mine);
  return roots.filter((p) => fs.existsSync(p));
}

function cacheDir(): string {
  const d = path.join(dataDir(), "library-cache");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function firstFile(dir: string, filter: (name: string) => boolean): string | undefined {
  try {
    const files = fs.readdirSync(dir).filter(filter).sort();
    return files[0] ? path.join(dir, files[0]) : undefined;
  } catch {
    return undefined;
  }
}

function readTitle(dir: string, fallback: string): { title: string; type?: string } {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    return { title: pj.title ?? fallback, type: (pj.type ?? "").toLowerCase() };
  } catch {
    return { title: fallback };
  }
}

export function scanLibrary(): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const root of libraryRoots()) {
    const isWorkshop = root.includes("431960");
    let dirs: string[] = [];
    if (isWorkshop) {
      dirs = fs
        .readdirSync(root)
        .map((d) => path.join(root, d))
        .filter((d) => fs.statSync(d).isDirectory());
    } else {
      dirs = [root];
    }
    for (const dir of dirs) {
      const base = path.basename(dir);
      if (isWorkshop) {
        const { title, type } = readTitle(dir, base);
        const preview = firstFile(dir, (n) => /^preview\.(jpe?g|png|gif)$/i.test(n));
        const video = firstFile(dir, (n) => isVideoPath(n));
        const id = `ws-${base}`;
        if (type === "scene" || (type === undefined && fs.existsSync(path.join(dir, "scene.pkg")))) {
          const still = path.join(cacheDir(), `${base}.png`);
          const stillExists = fs.existsSync(still);
          items.push({
            id,
            title,
            type: "scene",
            itemDir: dir,
            stillPath: stillExists ? still : undefined,
            thumbPath: preview ?? (stillExists ? still : ""),
            dims: stillExists ? readImageDims(still) : undefined,
          });
        } else if (video) {
          items.push({ id, title, type: "video", mediaPath: video, itemDir: dir, thumbPath: preview ?? "" });
        } else if (preview && IMAGE_EXT.has(path.extname(preview).toLowerCase())) {
          items.push({
            id,
            title,
            type: "image",
            mediaPath: preview,
            itemDir: dir,
            thumbPath: preview,
            dims: readImageDims(preview),
          });
        }
      } else {
        // Local wallpapers folder: one entry per media file.
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (!fs.statSync(p).isFile()) continue;
          const ext = path.extname(name).toLowerCase();
          if (isVideoPath(p)) {
            items.push({ id: `my-${name}`, title: name.replace(ext, ""), type: "video", mediaPath: p, thumbPath: "" });
          } else if (IMAGE_EXT.has(ext)) {
            items.push({
              id: `my-${name}`,
              title: name.replace(ext, ""),
              type: "image",
              mediaPath: p,
              thumbPath: p,
              dims: readImageDims(p),
            });
          }
        }
      }
    }
  }
  return items;
}

/** Finds a library item by id across a fresh scan. */
export function findItem(id: string): LibraryItem | undefined {
  return scanLibrary().find((i) => i.id === id);
}

/**
 * Extracts the largest embedded texture as the scene's still background.
 * The same PKGV/TEX parsing proven when pulling 长安雪 and ATRI out of their
 * packages; result is cached per workshop item. Newer pkgs (PKGV0021+) embed
 * a PNG inside the .tex; older ones (PKGV0012-) store raw mipmaps which we
 * do not decode — those fall back to the item's preview.jpg.
 */
export function extractSceneStill(item: LibraryItem): string | undefined {
  if (!item.itemDir) return item.stillPath;
  const base = path.basename(item.itemDir);
  const still = path.join(cacheDir(), `${base}.png`);
  if (fs.existsSync(still)) return still;
  const pkgPath = path.join(item.itemDir, "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const carved = carveLargestEmbeddedPkgImage(pkgPath, still);
    if (carved) return still;
  }
  // Fallback: the workshop preview is always present and always decodable.
  const preview = firstFile(item.itemDir, (n) => /^preview\.(jpe?g|png)$/i.test(n));
  if (preview) {
    const fallback = path.join(cacheDir(), `${base}-preview.jpg`);
    fs.copyFileSync(preview, fallback);
    return fallback;
  }
  return undefined;
}

function carveLargestEmbeddedPkgImage(pkgPath: string, outPath: string): boolean {
  try {
    const buf = fs.readFileSync(pkgPath);
    let pos = 0;
    const readInt32 = () => { const v = buf.readInt32LE(pos); pos += 4; return v; };
    const readString = () => { const len = readInt32(); const s = buf.toString("utf8", pos, pos + len); pos += len; return s; };
    readString(); // magic PKGV00xx
    const count = readInt32();
    // Entry table: path string + int32 relative offset + int32 length; the
    // data section starts right after the table.
    const table: { path: string; rel: number; length: number }[] = [];
    for (let i = 0; i < count; i++) {
      const p = readString();
      const rel = readInt32();
      const len = readInt32();
      table.push({ path: p, rel, length: len });
    }
    const dataStart = pos;
    const texEntries = table
      .filter((e) => e.path.toLowerCase().endsWith(".tex") && e.length > 1_000_000)
      .sort((a, b) => b.length - a.length);
    for (const tex of texEntries) {
      const data = buf.subarray(dataStart + tex.rel, dataStart + tex.rel + tex.length);
      const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const start = data.indexOf(PNG_MAGIC);
      if (start < 0) continue;
      let p = start + 8;
      let end = -1;
      while (p + 8 <= data.length) {
        const len = data.readUInt32BE(p);
        const type = data.toString("ascii", p + 4, p + 8);
        p = p + 8 + len + 4;
        if (type === "IEND") { end = p; break; }
      }
      if (end < 0) continue;
      fs.writeFileSync(outPath, data.subarray(start, end));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Size limit used by the panel import path (matches server MAX_WALLPAPER_BYTES). */
export const WALLPAPER_BYTES_LIMIT = 20 * 1024 * 1024;

/**
 * Images above the import limit (8K extracts, huge scans) are downscaled to a
 * 4K JPEG instead of failing — the injected layer is 2560px anyway, so nothing
 * visible is lost.
 */
export async function ensureWallpaperSized(sourcePath: string): Promise<string> {
  const stat = fs.statSync(sourcePath);
  if (stat.size <= WALLPAPER_BYTES_LIMIT - 2 * 1024 * 1024) return sourcePath;
  const parsed = path.parse(sourcePath);
  const dest = path.join(parsed.dir, `${parsed.name}-4k.jpg`);
  if (fs.existsSync(dest) && fs.statSync(dest).size <= WALLPAPER_BYTES_LIMIT) return dest;
  const img = await Jimp.read(sourcePath);
  const maxDim = Math.max(img.width, img.height);
  if (maxDim > 3840) {
    const scale = 3840 / maxDim;
    img.resize({ w: Math.round(img.width * scale), h: Math.round(img.height * scale) });
  }
  const out = await img.getBuffer(JimpMime.jpeg, { quality: 90 });
  fs.writeFileSync(dest, out);
  return dest;
}

/** JPEG thumbnail cache, keyed by source path + mtime + requested width. */
export async function thumbnailFor(sourcePath: string, width = 320): Promise<string | undefined> {
  if (!sourcePath || !fs.existsSync(sourcePath)) return undefined;
  const stat = fs.statSync(sourcePath);
  const hash = crypto
    .createHash("md5")
    .update(`${sourcePath}|${Math.floor(stat.mtimeMs / 60000)}|${width}`)
    .digest("hex")
    .slice(0, 16);
  const dest = path.join(cacheDir(), "thumbs", `${hash}.jpg`);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const img = await Jimp.read(sourcePath);
    const scale = Math.min(1, width / img.width);
    if (scale < 1) img.resize({ w: width, h: Math.round(img.height * scale) });
    const out = await img.getBuffer(JimpMime.jpeg, { quality: width > 320 ? 84 : 72 });
    fs.writeFileSync(dest, out);
    return dest;
  } catch {
    return undefined;
  }
}
