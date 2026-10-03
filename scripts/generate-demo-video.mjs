import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, "marketing-assets");
const frameDir = join(outDir, "demo-frames");
const pngFrameDir = join(outDir, "demo-frames-png");
const fps = 24;
const duration = 11;
const frames = fps * duration;
const width = 1280;
const height = 720;

rmSync(frameDir, { recursive: true, force: true });
rmSync(pngFrameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });
mkdirSync(pngFrameDir, { recursive: true });

const prompts = [
  "A cinematic sunrise over a futuristic city",
  "A product reveal with soft studio lighting",
  "Ocean waves at golden hour, realistic detail",
];

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const ease = (value) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

function lerp(a, b, t) {
  return a + (b - a) * ease(t);
}

function typedText(t) {
  const full = prompts.join("\n");
  const visible = Math.floor(full.length * ease((t - 0.8) / 2.5));
  return full.slice(0, visible);
}

function linesForText(text) {
  return text.split("\n").map((line) => esc(line));
}

function cursorPath(x, y) {
  return `
    <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" filter="url(#shadow)">
      <path d="M0 0 0 34 9 26 16 43 25 39 18 23 31 23Z" fill="#ffffff" stroke="#10212b" stroke-width="2"/>
    </g>`;
}

function fileCard(x, y, name, progress, done) {
  const w = 306;
  const pct = clamp(progress);
  return `
    <g transform="translate(${x} ${y})" opacity="${pct > 0 ? 1 : 0}">
      <rect width="${w}" height="74" rx="12" fill="#0f171d" stroke="${done ? "#2d7a4b" : "#344854"}" stroke-width="2"/>
      <rect x="16" y="17" width="40" height="40" rx="9" fill="${done ? "#10341f" : "#132630"}"/>
      <path d="M36 20v22m0 0-9-9m9 9 9-9M25 50h22" fill="none" stroke="${done ? "#9ff3b4" : "#35c7e7"}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="70" y="32" fill="#edf6f9" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">${esc(name)}</text>
      <text x="70" y="55" fill="${done ? "#9fd6ad" : "#9fb0bb"}" font-family="Inter, Arial, sans-serif" font-size="14">${done ? "Downloaded" : "Downloading..."}</text>
      <rect x="196" y="48" width="92" height="8" rx="4" fill="#263844"/>
      <rect x="196" y="48" width="${(92 * pct).toFixed(1)}" height="8" rx="4" fill="${done ? "#5be081" : "#35c7e7"}"/>
    </g>`;
}

function stageLabel(t) {
  if (t < 3.5) return ["Paste prompts", "Drop in your batch list once, then let Flow Queue handle the repetition."];
  if (t < 5.6) return ["Click Run", "Start the queue with controlled concurrency for Google Flow generations."];
  if (t < 8.2) return ["Auto-download", "Completed images and videos are saved automatically."];
  return ["Ready to share", "Organized outputs land in your selected folder with clean numbering."];
}

function frameSvg(i) {
  const t = i / fps;
  const [label, sublabel] = stageLabel(t);
  const typed = typedText(t);
  const promptLines = linesForText(typed);
  const runPulse = t > 4.45 && t < 4.9 ? 1 : 0;
  const progress = clamp((t - 5.1) / 3.5);
  const completed = Math.floor(progress * 6);
  const panelX = 64;
  const panelY = 104;
  const panelW = 680;
  const outputX = 784;
  const outputY = 144;
  const cursorX =
    t < 3.5
      ? lerp(475, 650, t / 3.5)
      : t < 4.7
        ? lerp(650, 616, (t - 3.5) / 1.2)
        : t < 7.2
          ? lerp(616, 1010, (t - 4.7) / 2.5)
          : lerp(1010, 1090, (t - 7.2) / 2.0);
  const cursorY =
    t < 3.5
      ? lerp(338, 440, t / 3.5)
      : t < 4.7
        ? lerp(440, 556, (t - 3.5) / 1.2)
        : t < 7.2
          ? lerp(556, 530, (t - 4.7) / 2.5)
          : lerp(530, 606, (t - 7.2) / 2.0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="0.34"/>
    </filter>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101820"/>
      <stop offset="0.55" stop-color="#0a1218"/>
      <stop offset="1" stop-color="#111923"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f43b9d"/>
      <stop offset="1" stop-color="#28c7e7"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#hero)"/>
  <rect x="26" y="22" width="1228" height="676" rx="28" fill="#0b1116" stroke="#243542" stroke-width="2"/>

  <g transform="translate(52 42)">
    <rect width="58" height="58" rx="14" fill="#f8fbff"/>
    <path d="M13 13h29v10H25v8h16v10H25v18H13V13Z" fill="#f43b9d"/>
    <path d="M41 22c10 0 17 8 17 19 0 5-2 10-5 13l6 6-7 7-7-8h-4c-10 0-17-8-17-18s7-19 17-19Zm0 10c-4 0-6 3-6 9 0 5 2 8 6 8s6-3 6-8c0-6-2-9-6-9Z" fill="#28c7e7" fill-rule="evenodd"/>
  </g>
  <text x="128" y="72" fill="#f5fafc" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900">Flow Queue</text>
  <text x="128" y="100" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="17">Auto Veo &amp; Nano Banana for Google Flow</text>
  <rect x="1012" y="48" width="188" height="46" rx="23" fill="#0e171d" stroke="#334856" stroke-width="2"/>
  <text x="1106" y="77" text-anchor="middle" fill="#eef6f8" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">${esc(label)}</text>

  <g transform="translate(${panelX} ${panelY})" filter="url(#shadow)">
    <rect width="${panelW}" height="570" rx="18" fill="#121a20" stroke="#33434d" stroke-width="2"/>
    <rect x="22" y="22" width="636" height="64" rx="12" fill="#10241a" stroke="#2b7547" stroke-width="2"/>
    <text x="44" y="58" fill="#dff6e7" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Ready to use</text>
    <text x="44" y="78" fill="#9fcab0" font-family="Inter, Arial, sans-serif" font-size="13">This tab is ready for queued image and video generation.</text>

    <text x="28" y="126" fill="#eef4f7" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Queue</text>
    <text x="650" y="126" text-anchor="end" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="16">3 prompts</text>
    <rect x="28" y="148" width="150" height="42" rx="8" fill="#267fa0"/>
    <text x="103" y="175" text-anchor="middle" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="800">Text to video</text>
    <rect x="188" y="148" width="150" height="42" rx="8" fill="#0e151a" stroke="#354650" stroke-width="2"/>
    <text x="263" y="175" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="800">Image to video</text>
    <rect x="348" y="148" width="150" height="42" rx="8" fill="#0e151a" stroke="#354650" stroke-width="2"/>
    <text x="423" y="175" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="800">Text to image</text>
    <rect x="508" y="148" width="150" height="42" rx="8" fill="#0e151a" stroke="#354650" stroke-width="2"/>
    <text x="583" y="175" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="800">Image to image</text>

    <text x="28" y="232" fill="#bdcbd3" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="800">Prompts</text>
    <rect x="28" y="248" width="630" height="144" rx="10" fill="#0d1419" stroke="#3b4c57" stroke-width="2"/>
    ${promptLines
      .map(
        (line, idx) =>
          `<text x="50" y="${285 + idx * 34}" fill="#e8eff3" font-family="Inter, Arial, sans-serif" font-size="18">${line}</text>`,
      )
      .join("\n")}
    ${
      t < 3.6
        ? `<rect x="${50 + (promptLines.at(-1)?.length ?? 0) * 9.2}" y="${270 + Math.max(0, promptLines.length - 1) * 34}" width="3" height="22" fill="#35c7e7" opacity="${Math.sin(t * 12) > 0 ? 1 : 0.15}"/>`
        : ""
    }

    <rect x="28" y="420" width="180" height="52" rx="10" fill="#0d1419" stroke="#3b4c57" stroke-width="2"/>
    <text x="118" y="453" text-anchor="middle" fill="#dbe5ea" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="800">Add images</text>
    <rect x="418" y="420" width="240" height="52" rx="10" fill="#2ca3ca" stroke="${runPulse ? "#ffffff" : "#2ca3ca"}" stroke-width="${runPulse ? 6 : 2}"/>
    <path d="m450 436 18 10-18 10Z" fill="#fff"/>
    <text x="548" y="453" text-anchor="middle" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="900">Run queue</text>

    <rect x="28" y="504" width="630" height="42" rx="10" fill="#0d1419" stroke="#2d3e49" stroke-width="2"/>
    <text x="48" y="530" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="800">CURRENT RUN</text>
    <rect x="176" y="518" width="330" height="12" rx="6" fill="#28363f"/>
    <rect x="176" y="518" width="${(330 * progress).toFixed(1)}" height="12" rx="6" fill="#28c7e7"/>
    <text x="636" y="532" text-anchor="end" fill="#eef4f7" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="900">${completed} / 3</text>
  </g>

  <g transform="translate(${outputX} ${outputY})" filter="url(#shadow)">
    <rect width="394" height="462" rx="22" fill="#101820" stroke="#33434d" stroke-width="2"/>
    <text x="30" y="46" fill="#f5fafc" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="900">Downloads</text>
    <text x="30" y="74" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="15">Auto download is ON</text>
    <rect x="286" y="30" width="78" height="36" rx="18" fill="#36a8ce"/>
    <circle cx="346" cy="48" r="15" fill="#fff"/>
    <rect x="30" y="102" width="334" height="64" rx="14" fill="#0d1419" stroke="#2d3e49" stroke-width="2"/>
    <text x="52" y="139" fill="#eaf2f5" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">Folder</text>
    <text x="126" y="139" fill="#35c7e7" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="900">flow-queue/</text>
    ${fileCard(30, 190, "flow-queue-001.mp4", clamp((t - 6.0) / 1.0), t > 7.0)}
    ${fileCard(30, 276, "flow-queue-002.mp4", clamp((t - 7.0) / 1.0), t > 8.0)}
    ${fileCard(30, 362, "flow-queue-003.png", clamp((t - 8.0) / 1.0), t > 9.0)}
  </g>

  <g transform="translate(64 660)">
    <rect width="1152" height="34" rx="17" fill="#0f171d" stroke="#263844" stroke-width="2"/>
    <rect width="${(1152 * clamp(t / duration)).toFixed(1)}" height="34" rx="17" fill="url(#brand)" opacity="0.95"/>
    <text x="576" y="23" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="900">${esc(sublabel)}</text>
  </g>

  ${cursorPath(cursorX, cursorY)}
</svg>`;
}

for (let i = 0; i < frames; i += 1) {
  writeFileSync(join(frameDir, `frame-${String(i).padStart(4, "0")}.svg`), frameSvg(i));
}

for (let i = 0; i < frames; i += 1) {
  const index = String(i).padStart(4, "0");
  execFileSync(
    "sips",
    [
      "-s",
      "format",
      "png",
      join(frameDir, `frame-${index}.svg`),
      "--out",
      join(pngFrameDir, `frame-${index}.png`),
    ],
    { stdio: i % fps === 0 ? "inherit" : "ignore" },
  );
}

const mp4 = join(outDir, "flow-queue-demo.mp4");
const gif = join(outDir, "flow-queue-demo.gif");

execFileSync(
  "ffmpeg",
  [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(pngFrameDir, "frame-%04d.png"),
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    mp4,
  ],
  { stdio: "inherit" },
);

execFileSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    mp4,
    "-vf",
    "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop",
    "0",
    gif,
  ],
  { stdio: "inherit" },
);

console.log(`Created ${mp4}`);
console.log(`Created ${gif}`);
