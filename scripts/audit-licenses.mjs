import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const allowed = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"];
const packages = [
  "@vitejs/plugin-react",
  "vite",
  "typescript",
  "react",
  "react-dom",
  "lucide-react",
  "esbuild",
  "@types/chrome",
  "@types/react",
  "@types/react-dom",
  "eslint",
  "globals",
  "typescript-eslint"
];
const notices = [];
const failures = [];

for (const name of packages) {
  const packagePath = path.join(root, "node_modules", ...name.split("/"), "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const license = normalizeLicense(pkg.license);
  if (!allowed.some((item) => license.includes(item))) {
    failures.push(`${name}: ${pkg.license || "UNKNOWN"}`);
  }
  notices.push(`${name}@${pkg.version}\nLicense: ${pkg.license || "UNKNOWN"}\n`);
}

if (failures.length > 0) {
  throw new Error(`Disallowed dependency licenses:\n${failures.join("\n")}`);
}

await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(
  path.join(root, "dist", "THIRD_PARTY_NOTICES.txt"),
  `Flow Queue third-party notices\n\n${notices.join("\n")}`,
  "utf8"
);

try {
  const distFiles = await readdir(path.join(root, "dist"), { recursive: true });
  const blocked = distFiles.filter((file) => /primeicons|white devil|BuAwiCGC|BlacBdI|CS8y_qIv|CbIdrXch/i.test(String(file)));
  if (blocked.length > 0) {
    throw new Error(`Blocked legacy artifact names found:\n${blocked.join("\n")}`);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function normalizeLicense(license) {
  return String(license || "").replace(/[()]/g, "").replace(/\s+OR\s+/g, " ");
}
