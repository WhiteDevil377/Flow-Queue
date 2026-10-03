import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "dist/manifest.json"), "utf8"));
const permissions = new Set(manifest.permissions ?? []);
const forbiddenPermissions = ["activeTab", "tabs"].filter((permission) => permissions.has(permission));

if (manifest.manifest_version !== 3) {
  throw new Error("Chrome Web Store release must use Manifest V3.");
}

if (forbiddenPermissions.length > 0) {
  throw new Error(`Unnecessary broad permissions found: ${forbiddenPermissions.join(", ")}`);
}

if (!manifest.minimum_chrome_version) {
  throw new Error("minimum_chrome_version must be declared.");
}

const files = [
  "dist/assets/background.js",
  "dist/assets/content.js",
  "dist/assets/sidepanel.js"
];

for (const file of files) {
  const source = await readFile(path.join(root, file), "utf8");
  if (/\beval\s*\(|\bnew\s+Function\s*\(|<script[^>]+https?:\/\//i.test(source)) {
    throw new Error(`Potential remote or dynamically evaluated code found in ${file}.`);
  }
}

console.log(`Chrome Web Store audit passed (${permissions.size} required permissions).`);
