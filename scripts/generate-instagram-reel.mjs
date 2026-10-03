import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, "marketing-assets");
const frameDir = join(outDir, "instagram-reel-frames");
const pngFrameDir = join(outDir, "instagram-reel-frames-png");
const fps = 24;
const duration = 15;
const frames = fps * duration;
const width = 1080;
const height = 1920;

rmSync(frameDir, { recursive: true, force: true });
rmSync(pngFrameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });
mkdirSync(pngFrameDir, { recursive: true });

const prompts = [
  "Cinematic product reveal",
  "Ocean waves at golden hour",
  "Futuristic city sunrise",
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
const lerp = (a, b, t) => a + (b - a) * ease(t);

function sceneCopy(t) {
  if (t < 2.2) {
    return {
      kicker: "Google Flow creators",
      headline: ["Stop downloading", "outputs one by one"],
      sub: "Queue prompts. Run batches. Save files automatically.",
      step: "Problem",
    };
  }
  if (t < 5.1) {
    return {
      kicker: "Step 1",
      headline: ["Paste your prompts", "once"],
      sub: "Drop a full batch list into Flow Queue.",
      step: "Paste",
    };
  }
  if (t < 7.5) {
    return {
      kicker: "Step 2",
      headline: ["Click Run queue"],
      sub: "Control concurrency for image and video generations.",
      step: "Run",
    };
  }
  if (t < 11.4) {
    return {
      kicker: "Step 3",
      headline: ["Auto-download", "completed media"],
      sub: "Images and videos land in your chosen folder.",
      step: "Download",
    };
  }
  if (t < 13.3) {
    return {
      kicker: "Clean output",
      headline: ["Rename and organize", "every file"],
      sub: "Folder, prefix, and numbering stay consistent.",
      step: "Organize",
    };
  }
  return {
    kicker: "Chrome extension",
    headline: ["Flow Queue"],
    sub: "Search Flow Queue on the Chrome Web Store.",
    step: "Install",
  };
}

function typedPrompts(t) {
  const full = prompts.join("\n");
  const visible = Math.floor(full.length * ease((t - 2.2) / 2.4));
  return full.slice(0, visible).split("\n");
}

function logo(x, y, size = 82) {
  const s = size / 82;
  return `
    <g transform="translate(${x} ${y}) scale(${s})">
      <rect width="82" height="82" rx="20" fill="#f8fbff"/>
      <path d="M18 18h41v15H35v11h22v15H35v23H18V18Z" fill="#f43b9d"/>
      <path d="M58 31c15 0 25 12 25 27 0 8-3 14-8 19l9 9-10 10-10-11h-6c-15 0-25-12-25-27s10-27 25-27Zm0 15c-6 0-9 5-9 12s3 12 9 12 9-5 9-12-3-12-9-12Z" fill="#28c7e7" fill-rule="evenodd"/>
    </g>`;
}

function cursor(x, y, scale = 1) {
  return `
    <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale})" filter="url(#softShadow)">
      <path d="M0 0 0 42 12 32 20 54 31 50 23 29 39 29Z" fill="#fff" stroke="#10212b" stroke-width="2.5"/>
    </g>`;
}

function downloadCard(x, y, name, progress, done) {
  const pct = clamp(progress);
  return `
    <g transform="translate(${x} ${y})" opacity="${pct > 0 ? 1 : 0}">
      <rect width="500" height="104" rx="24" fill="#0f171d" stroke="${done ? "#2d7a4b" : "#344854"}" stroke-width="2.5"/>
      <rect x="24" y="24" width="56" height="56" rx="14" fill="${done ? "#10341f" : "#132630"}"/>
      <path d="M52 26v30m0 0-13-13m13 13 13-13M36 72h33" fill="none" stroke="${done ? "#9ff3b4" : "#35c7e7"}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="104" y="47" fill="#edf6f9" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900">${esc(name)}</text>
      <text x="104" y="78" fill="${done ? "#9fd6ad" : "#9fb0bb"}" font-family="Inter, Arial, sans-serif" font-size="19">${done ? "Downloaded" : "Downloading..."}</text>
      <rect x="340" y="68" width="118" height="10" rx="5" fill="#263844"/>
      <rect x="340" y="68" width="${(118 * pct).toFixed(1)}" height="10" rx="5" fill="${done ? "#5be081" : "#35c7e7"}"/>
    </g>`;
}

function miniUi(t) {
  const promptLines = typedPrompts(t);
  const runPulse = t > 5.5 && t < 6.2;
  const progress = clamp((t - 6.2) / 4.7);
  const doneCount = Math.min(3, Math.floor(progress * 3.8));
  const uiScale = t < 2.15 ? lerp(0.82, 0.94, t / 2.15) : 0.94;

  return `
    <g transform="translate(82 585) scale(${uiScale})" filter="url(#cardShadow)">
      <rect width="976" height="740" rx="34" fill="#101820" stroke="#33434d" stroke-width="3"/>
      <rect x="28" y="28" width="920" height="88" rx="20" fill="#10241a" stroke="#2b7547" stroke-width="3"/>
      <text x="58" y="78" fill="#dff6e7" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="900">Ready to use</text>
      <text x="58" y="104" fill="#9fcab0" font-family="Inter, Arial, sans-serif" font-size="20">Queued image and video generation.</text>

      <text x="34" y="176" fill="#eef4f7" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900">Queue</text>
      <text x="914" y="176" text-anchor="end" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="25">3 prompts</text>

      <rect x="34" y="210" width="220" height="62" rx="13" fill="#267fa0"/>
      <text x="144" y="250" text-anchor="middle" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Text to video</text>
      <rect x="270" y="210" width="220" height="62" rx="13" fill="#0e151a" stroke="#354650" stroke-width="3"/>
      <text x="380" y="250" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Text to image</text>
      <rect x="506" y="210" width="220" height="62" rx="13" fill="#0e151a" stroke="#354650" stroke-width="3"/>
      <text x="616" y="250" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Image to video</text>

      <text x="34" y="330" fill="#bdcbd3" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Prompts</text>
      <rect x="34" y="356" width="908" height="210" rx="18" fill="#0d1419" stroke="#3b4c57" stroke-width="3"/>
      ${
        promptLines.length
          ? promptLines
              .map(
                (line, index) =>
                  `<text x="66" y="${410 + index * 52}" fill="#e8eff3" font-family="Inter, Arial, sans-serif" font-size="29" font-weight="800">${esc(line)}</text>`,
              )
              .join("\n")
          : `<text x="66" y="410" fill="#6f818d" font-family="Inter, Arial, sans-serif" font-size="29" font-weight="800">Paste prompts here...</text>`
      }

      <rect x="34" y="608" width="310" height="76" rx="18" fill="#0d1419" stroke="#3b4c57" stroke-width="3"/>
      <text x="189" y="656" text-anchor="middle" fill="#dbe5ea" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900">Add images</text>
      <rect x="594" y="608" width="348" height="76" rx="18" fill="#2ca3ca" stroke="${runPulse ? "#fff" : "#2ca3ca"}" stroke-width="${runPulse ? 8 : 3}"/>
      <path d="m648 631 28 15-28 15Z" fill="#fff"/>
      <text x="770" y="656" text-anchor="middle" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="29" font-weight="900">Run queue</text>

      <rect x="34" y="704" width="908" height="50" rx="18" fill="#0d1419" stroke="#2d3e49" stroke-width="3"/>
      <text x="64" y="736" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="900">CURRENT RUN</text>
      <rect x="272" y="724" width="470" height="14" rx="7" fill="#28363f"/>
      <rect x="272" y="724" width="${(470 * progress).toFixed(1)}" height="14" rx="7" fill="#28c7e7"/>
      <text x="908" y="740" text-anchor="end" fill="#eef4f7" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="900">${doneCount} / 3</text>
    </g>`;
}

function downloadPanel(t) {
  const first = clamp((t - 7.25) / 1.0);
  const second = clamp((t - 8.35) / 1.0);
  const third = clamp((t - 9.45) / 1.0);
  return `
    <g transform="translate(115 1205)" filter="url(#cardShadow)">
      <rect width="850" height="390" rx="34" fill="#0f171d" stroke="#33434d" stroke-width="3"/>
      <text x="44" y="70" fill="#f5fafc" font-family="Inter, Arial, sans-serif" font-size="40" font-weight="900">Auto-download</text>
      <text x="44" y="108" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="23">Completed media saves automatically.</text>
      <rect x="664" y="54" width="116" height="54" rx="27" fill="#36a8ce"/>
      <text x="700" y="88" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">ON</text>
      <circle cx="754" cy="81" r="23" fill="#fff"/>
      ${downloadCard(44, 148, "flow-queue-001.mp4", first, t > 8.25)}
      ${downloadCard(44, 260, "flow-queue-002.mp4", second, t > 9.35)}
      ${downloadCard(44, 372, "flow-queue-003.png", third, t > 10.45)}
    </g>`;
}

function phoneChrome(t) {
  const current = sceneCopy(t);
  const progress = clamp(t / duration);
  const cursorX =
    t < 4.9
      ? lerp(580, 730, (t - 2.2) / 2.7)
      : t < 6.4
        ? lerp(730, 830, (t - 4.9) / 1.5)
        : lerp(830, 720, (t - 6.4) / 3.8);
  const cursorY =
    t < 4.9
      ? lerp(900, 990, (t - 2.2) / 2.7)
      : t < 6.4
        ? lerp(990, 1186, (t - 4.9) / 1.5)
        : lerp(1186, 1470, (t - 6.4) / 3.8);

  const outroOpacity = ease((t - 13.15) / 1.0);
  const contentOpacity = 1 - ease((t - 13.05) / 0.8);
  const downloadOpacity = ease((t - 7.1) / 0.5) * (1 - ease((t - 12.6) / 0.7));

  return `
    <g opacity="${contentOpacity}">
      ${miniUi(t)}
      <g opacity="${downloadOpacity}">
        ${downloadPanel(t)}
      </g>
      ${cursor(cursorX, cursorY, 1.1)}
    </g>
    <g opacity="${outroOpacity}" filter="url(#cardShadow)">
      <rect x="96" y="640" width="888" height="650" rx="44" fill="#101820" stroke="#33434d" stroke-width="3"/>
      ${logo(450, 720, 180)}
      <text x="540" y="1008" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="76" font-weight="1000">Flow Queue</text>
      <text x="540" y="1072" text-anchor="middle" fill="#aab9c2" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800">Auto Veo &amp; Nano Banana</text>
      <rect x="258" y="1132" width="564" height="84" rx="42" fill="#35a8ce"/>
      <text x="540" y="1187" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="1000">Get it on Chrome Web Store</text>
    </g>
    <rect x="78" y="1728" width="924" height="30" rx="15" fill="#20313b"/>
    <rect x="78" y="1728" width="${(924 * progress).toFixed(1)}" height="30" rx="15" fill="url(#brand)"/>
    <text x="540" y="1775" text-anchor="middle" fill="#8fa4af" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="800">${esc(current.step)} demo</text>`;
}

function frameSvg(i) {
  const t = i / fps;
  const copy = sceneCopy(t);
  const pop = t < 1.0 ? lerp(0.96, 1, t) : 1;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="softShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000" flood-opacity="0.36"/>
    </filter>
    <filter id="cardShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="26" stdDeviation="28" flood-color="#000" flood-opacity="0.34"/>
    </filter>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101820"/>
      <stop offset="0.42" stop-color="#071016"/>
      <stop offset="1" stop-color="#111923"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f43b9d"/>
      <stop offset="1" stop-color="#28c7e7"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="88" cy="200" r="260" fill="#153141" opacity="0.32"/>
  <circle cx="980" cy="1408" r="300" fill="#311632" opacity="0.28"/>

  <g transform="translate(58 66)">
    ${logo(0, 0, 84)}
    <text x="108" y="37" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="40" font-weight="1000">Flow Queue</text>
    <text x="108" y="78" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800">For Google Flow creators</text>
  </g>

  <g transform="translate(60 190) scale(${pop})">
    <rect width="316" height="58" rx="29" fill="#0f171d" stroke="#334856" stroke-width="2"/>
    <text x="158" y="38" text-anchor="middle" fill="#35c7e7" font-family="Inter, Arial, sans-serif" font-size="23" font-weight="1000">${esc(copy.kicker)}</text>
    ${copy.headline
      .map(
        (line, index) =>
          `<text x="0" y="${145 + index * 82}" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="1000">${esc(line)}</text>`,
      )
      .join("\n")}
    <text x="0" y="${copy.headline.length > 1 ? 328 : 246}" fill="#aebdc5" font-family="Inter, Arial, sans-serif" font-size="29" font-weight="800">${esc(copy.sub)}</text>
  </g>

  ${phoneChrome(t)}
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

const mp4 = join(outDir, "flow-queue-instagram-reel.mp4");
const cover = join(outDir, "flow-queue-instagram-reel-cover.png");

execFileSync(
  "ffmpeg",
  [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(pngFrameDir, "frame-%04d.png"),
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=44100`,
    "-shortest",
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "medium",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
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
  ["-y", "-ss", "00:00:01.0", "-i", mp4, "-frames:v", "1", "-update", "1", cover],
  { stdio: "inherit" },
);

console.log(`Created ${mp4}`);
console.log(`Created ${cover}`);
