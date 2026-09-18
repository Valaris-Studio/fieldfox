import sharp from "sharp";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
for (const name of ["sorting-machine", "review-station"]) {
  await sharp(
    fileURLToPath(
      new URL(`../creative/fieldfox-story-kit/assets/${name}.png`, root),
    ),
  )
    .resize({ width: 1200 })
    .webp({ quality: 82 })
    .toFile(fileURLToPath(new URL(`public/assets/${name}.webp`, root)));
}
await sharp(fileURLToPath(new URL("artwork/review-detail.png", root)))
  .resize({ width: 1200 })
  .webp({ quality: 85 })
  .toFile(fileURLToPath(new URL("public/assets/review-detail.webp", root)));
