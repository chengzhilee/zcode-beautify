// Carve the embedded PNG out of a WE .tex file (walk chunks to the real IEND).
import fs from "node:fs";
const [,, texFile, outFile] = process.argv;
const buf = fs.readFileSync(texFile);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const start = buf.indexOf(PNG_MAGIC);
if (start < 0) { console.error("no PNG inside"); process.exit(1); }
let p = start + 8;
while (p + 8 <= buf.length) {
  const len = buf.readUInt32BE(p);
  const type = buf.toString("ascii", p + 4, p + 8);
  const end = p + 8 + len + 4;
  if (type === "IEND") {
    fs.writeFileSync(outFile, buf.subarray(start, end));
    const img = buf.subarray(start, end);
    console.log("carved PNG:", outFile, end - start, "bytes",
      img.readUInt32BE(16) + "x" + img.readUInt32BE(20));
    process.exit(0);
  }
  p = end;
}
console.error("IEND not found");
process.exit(1);
