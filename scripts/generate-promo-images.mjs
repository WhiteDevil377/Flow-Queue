import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, "marketing-assets");
mkdirSync(outDir, { recursive: true });

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function logo(x, y, size = 92) {
  const s = size / 92;
  return `
    <g transform="translate(${x} ${y}) scale(${s})">
      <rect width="92" height="92" rx="22" fill="#f8fbff"/>
      <path d="M20 20h46v16H40v13h24v16H40v27H20V20Z" fill="#f43b9d"/>
      <path d="M65 34c17 0 28 13 28 30 0 9-3 16-9 22l10 10-12 11-11-13h-6c-17 0-28-13-28-30s11-30 28-30Zm0 16c-7 0-10 5-10 14s3 14 10 14 10-5 10-14-3-14-10-14Z" fill="#28c7e7" fill-rule="evenodd"/>
    </g>`;
}

function pill(x, y, text, color = "#28c7e7", width = 270) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="58" rx="29" fill="#0e171d" stroke="#334856" stroke-width="2.5"/>
      <circle cx="34" cy="29" r="8" fill="${color}"/>
      <text x="58" y="38" fill="#eaf5f8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">${esc(text)}</text>
    </g>`;
}

function featureCard(x, y, icon, title, body, width = 300) {
  return `
    <g transform="translate(${x} ${y})" filter="url(#smallShadow)">
      <rect width="${width}" height="152" rx="26" fill="#0f171d" stroke="#30434f" stroke-width="2.5"/>
      <rect x="24" y="24" width="54" height="54" rx="16" fill="#132630"/>
      ${icon}
      <text x="96" y="54" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="1000">${esc(title)}</text>
      <text x="96" y="90" fill="#aab9c2" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700">${esc(body)}</text>
    </g>`;
}

function downloadIcon(color = "#35c7e7") {
  return `<path d="M51 34v25m0 0-11-11m11 11 11-11M38 70h26" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function queueIcon(color = "#f43b9d") {
  return `<path d="M39 38h26M39 52h22M39 66h26" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/><circle cx="30" cy="38" r="4" fill="${color}"/><circle cx="30" cy="52" r="4" fill="${color}"/><circle cx="30" cy="66" r="4" fill="${color}"/>`;
}

function folderIcon(color = "#69e08b") {
  return `<path d="M30 42h18l7 8h22v25H30Z" fill="none" stroke="${color}" stroke-width="6" stroke-linejoin="round"/><path d="M30 50h47" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`;
}

function cursor(x, y, scale = 1) {
  return `
    <g transform="translate(${x} ${y}) scale(${scale})" filter="url(#smallShadow)">
      <path d="M0 0 0 50 14 38 24 64 37 59 27 34 46 34Z" fill="#ffffff" stroke="#0c151c" stroke-width="3"/>
    </g>`;
}

function promptUi(x, y, scale = 1) {
  return `
    <g transform="translate(${x} ${y}) scale(${scale})" filter="url(#cardShadow)">
      <rect width="860" height="590" rx="34" fill="#101820" stroke="#344653" stroke-width="3"/>
      <rect x="32" y="32" width="796" height="76" rx="20" fill="#10241a" stroke="#2b7547" stroke-width="3"/>
      <text x="62" y="80" fill="#dff6e7" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="1000">Ready to use</text>
      <text x="670" y="80" fill="#9fcab0" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="800">3 prompts</text>

      <text x="38" y="160" fill="#eef4f7" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="1000">Queue</text>
      <rect x="38" y="194" width="206" height="62" rx="14" fill="#2ca3ca"/>
      <text x="141" y="234" text-anchor="middle" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="1000">Text to video</text>
      <rect x="262" y="194" width="206" height="62" rx="14" fill="#0d1419" stroke="#3b4c57" stroke-width="3"/>
      <text x="365" y="234" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Text to image</text>
      <rect x="486" y="194" width="206" height="62" rx="14" fill="#0d1419" stroke="#3b4c57" stroke-width="3"/>
      <text x="589" y="234" text-anchor="middle" fill="#c5d1d8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="900">Image to video</text>

      <text x="38" y="310" fill="#bdcbd3" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="900">Prompts</text>
      <rect x="38" y="338" width="784" height="154" rx="18" fill="#0d1419" stroke="#3b4c57" stroke-width="3"/>
      <text x="70" y="390" fill="#eff7fa" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="900">Cinematic product reveal</text>
      <text x="70" y="432" fill="#eff7fa" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="900">Ocean waves at golden hour</text>
      <text x="70" y="474" fill="#eff7fa" font-family="Inter, Arial, sans-serif" font-size="27" font-weight="900">Futuristic city sunrise</text>

      <rect x="38" y="526" width="270" height="72" rx="18" fill="#0d1419" stroke="#3b4c57" stroke-width="3"/>
      <text x="173" y="571" text-anchor="middle" fill="#dbe5ea" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="1000">Add images</text>
      <rect x="500" y="526" width="322" height="72" rx="18" fill="#2ca3ca"/>
      <path d="m548 548 27 14-27 14Z" fill="#fff"/>
      <text x="682" y="571" text-anchor="middle" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="1000">Run queue</text>
    </g>`;
}

function downloadsPanel(x, y, scale = 1) {
  return `
    <g transform="translate(${x} ${y}) scale(${scale})" filter="url(#cardShadow)">
      <rect width="720" height="332" rx="34" fill="#0f171d" stroke="#344653" stroke-width="3"/>
      <text x="38" y="66" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="38" font-weight="1000">Auto-download</text>
      <text x="38" y="104" fill="#aab9c2" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800">Completed files save automatically.</text>
      <rect x="568" y="48" width="104" height="52" rx="26" fill="#35a8ce"/>
      <text x="598" y="81" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="1000">ON</text>
      <circle cx="648" cy="74" r="22" fill="#fff"/>

      <rect x="38" y="138" width="510" height="74" rx="18" fill="#10241a" stroke="#2b7547" stroke-width="3"/>
      <rect x="58" y="154" width="42" height="42" rx="12" fill="#10341f"/>
      <path d="M79 156v23m0 0-10-10m10 10 10-10M66 190h26" fill="none" stroke="#9ff3b4" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="124" y="171" fill="#eff7fa" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="1000">flow-queue-001.mp4</text>
      <text x="124" y="197" fill="#9fd6ad" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">Downloaded</text>

      <rect x="38" y="226" width="510" height="74" rx="18" fill="#0d1419" stroke="#344653" stroke-width="3"/>
      <rect x="58" y="242" width="42" height="42" rx="12" fill="#132630"/>
      <path d="M79 244v23m0 0-10-10m10 10 10-10M66 278h26" fill="none" stroke="#35c7e7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="124" y="259" fill="#eff7fa" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="1000">flow-queue-002.png</text>
      <text x="124" y="285" fill="#9fb0bb" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800">Downloading...</text>
      <rect x="390" y="270" width="104" height="10" rx="5" fill="#263844"/>
      <rect x="390" y="270" width="72" height="10" rx="5" fill="#35c7e7"/>
    </g>`;
}

function defs() {
  return `
    <defs>
      <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="30" stdDeviation="34" flood-color="#000" flood-opacity="0.38"/>
      </filter>
      <filter id="smallShadow" x="-35%" y="-35%" width="170%" height="170%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity="0.3"/>
      </filter>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0f1d25"/>
        <stop offset="0.46" stop-color="#071016"/>
        <stop offset="1" stop-color="#181125"/>
      </linearGradient>
      <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f43b9d"/>
        <stop offset="1" stop-color="#28c7e7"/>
      </linearGradient>
      <linearGradient id="cta" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#2ca3ca"/>
        <stop offset="1" stop-color="#38d1ec"/>
      </linearGradient>
      <clipPath id="slant">
        <path d="M0 0H1080V1350H0Z"/>
      </clipPath>
    </defs>`;
}

function background(width, height) {
  return `
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <path d="M-90 188C140 64 390 60 612 180C822 294 968 484 1168 500V-80H-90Z" fill="#122f3e" opacity="0.5"/>
    <path d="M-120 ${height - 120}C170 ${height - 268} 446 ${height - 250} 724 ${height - 92}C884 ${height - 2} 1012 ${height + 10} 1180 ${height - 36}V${height + 120}H-120Z" fill="#28152f" opacity="0.58"/>
    <path d="M70 ${height - 118}H1010" stroke="#263946" stroke-width="34" stroke-linecap="round"/>
    <path d="M70 ${height - 118}H520" stroke="url(#brand)" stroke-width="34" stroke-linecap="round"/>
    <path d="M-18 690L1080 250" stroke="#28c7e7" stroke-width="2" opacity="0.18"/>
    <path d="M0 782L1140 342" stroke="#f43b9d" stroke-width="2" opacity="0.13"/>`;
}

function portraitSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  ${defs()}
  ${background(1080, 1350)}
  ${logo(64, 62, 96)}
  <text x="184" y="104" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="1000">Flow Queue</text>
  <text x="184" y="144" fill="#aab9c2" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800">Auto Veo &amp; Nano Banana for Google Flow</text>
  ${pill(64, 206, "Chrome extension", "#35c7e7", 310)}
  <text x="64" y="322" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="78" font-weight="1000">Stop downloading</text>
  <text x="64" y="408" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="78" font-weight="1000">outputs one by one</text>
  <text x="68" y="466" fill="#b7c6ce" font-family="Inter, Arial, sans-serif" font-size="31" font-weight="800">Queue prompts, run batches, and save every result automatically.</text>

  ${featureCard(64, 520, queueIcon(), "Prompt queue", "Paste many prompts once.", 292)}
  ${featureCard(394, 520, downloadIcon(), "Auto-save", "Download completed media.", 292)}
  ${featureCard(724, 520, folderIcon(), "Organized", "Folder, prefix, numbering.", 292)}

  ${promptUi(88, 724, 0.82)}
  ${downloadsPanel(352, 1002, 0.86)}
  ${cursor(836, 988, 1.05)}

  <g filter="url(#smallShadow)">
    <rect x="64" y="1217" width="952" height="76" rx="38" fill="url(#cta)"/>
    <text x="540" y="1265" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="1000">Search “Flow Queue” on the Chrome Web Store</text>
  </g>
</svg>`;
}

function squareSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  ${defs()}
  ${background(1080, 1080)}
  ${logo(62, 56, 92)}
  <text x="178" y="98" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="1000">Flow Queue</text>
  <text x="178" y="137" fill="#aab9c2" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800">For Google Flow creators</text>
  ${pill(744, 72, "Chrome extension", "#35c7e7", 284)}

  <text x="64" y="254" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="76" font-weight="1000">Automate your</text>
  <text x="64" y="336" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="76" font-weight="1000">Google Flow queue</text>
  <text x="68" y="392" fill="#b7c6ce" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="800">Batch prompts. Auto-download outputs. Keep files organized.</text>

  ${promptUi(62, 466, 0.69)}
  ${downloadsPanel(530, 642, 0.68)}
  ${cursor(852, 610, 0.9)}

  ${featureCard(64, 890, queueIcon(), "Queue prompts", "Run more in less time.", 292)}
  ${featureCard(394, 890, downloadIcon(), "Auto-download", "Save every output.", 292)}
  ${featureCard(724, 890, folderIcon(), "Clean names", "Stay organized.", 292)}
</svg>`;
}

const outputs = [
  ["flow-queue-promo-post-1080x1350", portraitSvg()],
  ["flow-queue-promo-square-1080x1080", squareSvg()],
];

for (const [name, svg] of outputs) {
  const svgPath = join(outDir, `${name}.svg`);
  const pngPath = join(outDir, `${name}.png`);
  writeFileSync(svgPath, svg);
  execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "inherit" });
  console.log(`Created ${pngPath}`);
}
