import type { FlowSelectors } from "./types";

export const flowSelectors: FlowSelectors = {
  createProjectButtons: [
    'button[aria-label*="Create" i]',
    'button[aria-label*="New" i]',
    'button:has(i)'
  ],
  modeConfigButtons: [
    'button[aria-haspopup="dialog"][aria-label*="Settings" i]',
    'button[aria-label*="Settings" i]',
    'button:has(i)'
  ],
  videoConfigButtons: [
    'button[aria-haspopup="dialog"][aria-label*="Video" i]',
    'button[color="BLURPLE"][aria-haspopup="dialog"]'
  ],
  imageConfigButtons: [
    'button[aria-haspopup="dialog"][aria-label*="Image" i]',
    'button[aria-label*="Tune" i]'
  ],
  promptEditors: [
    'div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="plaintext-only"]',
    '[role="textbox"][contenteditable]',
    'div[role="textbox"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[contenteditable]:not([contenteditable="false"])',
    'textarea[placeholder*="create" i]',
    'textarea[aria-label*="prompt" i]',
    "textarea",
    'input[placeholder*="create" i]',
    'input[aria-label*="prompt" i]'
  ],
  submitButtons: [
    'button[aria-label*="Submit" i]',
    'button[aria-label*="Generate" i]',
    'button:has(i)'
  ],
  fileInputs: ['input[type="file"]'],
  outputTiles: [
    "div[data-tile-id]",
    'a[href*="/edit/"]'
  ],
  tileById: (tileId: string) => `div[data-tile-id="${cssEscape(tileId)}"]`,
  editLinkById: (tileId: string) => `div[data-tile-id="${cssEscape(tileId)}"] a[href*="/edit/"]`,
  tileProgress: [
    '[aria-valuenow]',
    '[role="progressbar"]',
    "div"
  ],
  hoverMenuButtons: [
    'button[aria-haspopup="menu"][aria-label*="More" i]',
    'button[aria-label*="More" i]',
    'button:has(i)'
  ],
  downloadButtons: [
    'button[aria-label*="Download" i]',
    '[aria-haspopup="menu"] button',
    'button:has(i)'
  ],
  doneButtons: [
    'button[aria-label*="Done" i]',
    'button[aria-label*="Close" i]',
    "header button:last-of-type"
  ],
  profileButtons: [
    'button:has(img[width="32"])',
    'button[aria-label*="account" i]'
  ],
  closeDialogButtons: [
    'div[role="dialog"] button[aria-label*="Close" i]',
    'div[role="dialog"] button:last-of-type'
  ],
  characterTabButtons: [
    'button[aria-label*="Character" i]',
    'button[aria-label*="Asset" i]'
  ],
  characterNameItems: [
    "div[data-tile-id] img[alt]",
    "div[data-tile-id]"
  ],
  searchInputs: [
    'input[type="search"]',
    'input[type="text"]'
  ]
};

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
