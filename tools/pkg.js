// Parse a Wallpaper Engine .pkg (PKGV format), list entries, optionally extract one.
import fs from "node:fs";

const [,, pkgFile, mode, arg] = process.argv;
const buf = fs.readFileSync(pkgFile);
let pos = 0;
const readInt32 = () => { const v = buf.readInt32LE(pos); pos += 4; return v; };
const readString = () => { const len = readInt32(); const s = buf.toString("utf8", pos, pos + len); pos += len; return s; };

const magic = readString();
const count = readInt32();
const entries = [];
for (let i = 0; i < count; i++) {
  const p = readString(); const rel = readInt32(); const len = readInt32();
  entries.push({ path: p, rel, length: len });
}
const dataStart = pos;
const abs = entries.map((e) => ({ path: e.path, offset: dataStart + e.rel, length: e.length }));

if (mode === "list") {
  console.log("magic:", magic, "entries:", count);
  const sorted = [...abs].sort((a, b) => b.length - a.length);
  console.log("\nlargest entries:");
  for (const e of sorted.slice(0, 10)) console.log(`  ${(e.length / 1e6).toFixed(2)}MB  ${e.path}`);
} else if (mode === "extract") {
  const e = abs.find((x) => x.path === arg);
  if (!e) { console.error("entry not found:", arg); process.exit(1); }
  const data = buf.subarray(e.offset, e.offset + e.length);
  const out = process.argv[5];
  fs.writeFileSync(out, data);
  console.log("extracted", arg, "->", out, e.length, "bytes");
  const h = data.subarray(0, 64);
  console.log("head:", [...h.subarray(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join(" "),
    "|", h.toString("ascii", 0, 32).replace(/[^\x20-\x7e]/g, "."));
}
