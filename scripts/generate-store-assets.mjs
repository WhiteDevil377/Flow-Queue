import { cp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const sourceDir = path.join(root, "store-assets/source");
const outputDir = path.join(root, "store-assets/ready");

await mkdir(outputDir, { recursive: true });
await cp(path.join(root, "public/icons/icon-128.png"), path.join(outputDir, "icon-128.png"));

const assets = [
  ["small-promo.svg", "small-promo-440x280.png", 440, 280],
  ["marquee-promo.svg", "marquee-promo-1400x560.png", 1400, 560],
  ["screenshot-queue.svg", "screenshot-1-queue-1280x800.png", 1280, 800],
  ["screenshot-settings.svg", "screenshot-2-settings-1280x800.png", 1280, 800],
  ["screenshot-workflows.svg", "screenshot-3-workflows-1280x800.png", 1280, 800],
  ["screenshot-runs.svg", "screenshot-4-runs-1280x800.png", 1280, 800],
  ["screenshot-language.svg", "screenshot-5-language-diagnostics-1280x800.png", 1280, 800]
];

for (const [source, output, width, height] of assets) {
  const flattenedJpeg = path.join(outputDir, `${output}.flatten.jpg`);
  await execFileAsync("sips", [
    "-s", "format", "jpeg",
    "-s", "formatOptions", "100",
    "--resampleHeightWidth", String(height), String(width),
    path.join(sourceDir, source),
    "--out", flattenedJpeg
  ]);
  await execFileAsync("sips", [
    "-s", "format", "png",
    flattenedJpeg,
    "--out", path.join(outputDir, output)
  ]);
  await rm(flattenedJpeg, { force: true });
}

console.log(`Generated ${assets.length + 1} Chrome Web Store image assets.`);
