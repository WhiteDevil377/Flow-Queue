import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseDir = path.join(root, "release");
const archiveName = `flow-queue-${pkg.version}-chrome-web-store.zip`;
const archivePath = path.join(releaseDir, archiveName);

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
await execFileAsync("zip", ["-X", "-q", "-r", archivePath, "."], {
  cwd: path.join(root, "dist")
});

const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath]);
const entries = stdout.trim().split("\n").filter(Boolean);
const forbidden = entries.filter((entry) =>
  entry.startsWith("dist/") ||
  /(?:^|\/)(?:src|scripts|node_modules)(?:\/|$)|\.(?:map|ts|tsx)$|(?:^|\/)\.DS_Store$/i.test(entry)
);

if (!entries.includes("manifest.json")) {
  throw new Error("Release ZIP does not contain manifest.json at its root.");
}
if (forbidden.length > 0) {
  throw new Error(`Forbidden files found in release ZIP:\n${forbidden.join("\n")}`);
}

const bytes = await readFile(archivePath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(
  path.join(releaseDir, "SHA256SUMS.txt"),
  `${sha256}  ${archiveName}\n`,
  "utf8"
);

console.log(`Created ${path.relative(root, archivePath)} (${entries.length} entries).`);
console.log(`SHA-256: ${sha256}`);
