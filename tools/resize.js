// Downscale the carved 8K PNG to 4K so it stays under the plugin's 20 MB
// panel-import limit and wastes less disk (injection downsizes to 2560 anyway).
import { Jimp, JimpMime } from "jimp";

const [, , inFile, outFile, targetW] = process.argv;
const img = await Jimp.read(inFile);
const w = Number(targetW) || 3840;
const h = Math.round((img.height / img.width) * w);
img.resize({ w, h });
await img.write(outFile, { mime: JimpMime.png });
console.log(`resized ${img.width}x${img.height} -> ${outFile}`);
