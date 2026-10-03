import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

await mkdir(path.join(dist, "assets"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/background/index.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outfile: path.join(dist, "assets/background.js"),
  legalComments: "none",
  minify: true,
  sourcemap: false,
  treeShaking: true
});

await build({
  entryPoints: [path.join(root, "src/content/index.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outfile: path.join(dist, "assets/content.js"),
  legalComments: "none",
  minify: true,
  sourcemap: false,
  treeShaking: true
});

await cp(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));

const builtSidepanelHtml = await readFile(path.join(dist, "src/sidepanel/index.html"), "utf8");
await writeFile(
  path.join(dist, "sidepanel.html"),
  builtSidepanelHtml.replaceAll('src="/assets/', 'src="assets/').replaceAll('href="/assets/', 'href="assets/'),
  "utf8"
);
await writeFile(
  path.join(root, "sidepanel.html"),
  builtSidepanelHtml.replaceAll('src="/assets/', 'src="dist/assets/').replaceAll('href="/assets/', 'href="dist/assets/'),
  "utf8"
);

await rm(path.join(dist, "src"), { recursive: true, force: true });
await rm(path.join(dist, "assets/selectors-BKV0dsCU.js"), { force: true });
await rm(path.join(dist, ".DS_Store"), { force: true });
