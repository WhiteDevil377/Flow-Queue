import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const files = await readdir(dist, { recursive: true });
const forbiddenFiles = files.filter((file) =>
  /(?:^|\/)(?:src|scripts|node_modules)(?:\/|$)|(?:^|\/)\.DS_Store$|\.(?:map|ts|tsx)$/i.test(String(file))
);

if (forbiddenFiles.length > 0) {
  throw new Error(`Source or development files found in release:\n${forbiddenFiles.join("\n")}`);
}

const javascriptFiles = files.filter((file) => String(file).endsWith(".js"));
const readableSourceMarkers = [];

for (const file of javascriptFiles) {
  const source = await readFile(path.join(dist, String(file)), "utf8");
  if (/\/\/\s*src\/|sourceMappingURL|sourcesContent/.test(source)) {
    readableSourceMarkers.push(String(file));
  }
}

if (readableSourceMarkers.length > 0) {
  throw new Error(`Readable source metadata found in release:\n${readableSourceMarkers.join("\n")}`);
}

console.log(`Release audit passed (${files.length} packaged files, no source maps or source files).`);
