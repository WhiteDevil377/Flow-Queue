# Privacy Practices Answers

## Single purpose

Flow Queue automates user-directed batches of image and video prompts in Google Flow and optionally downloads and organizes the resulting media.

## Permission justifications

### clipboardWrite

Used only when the user copies diagnostic logs or when a user-selected reference image must be placed on the clipboard for insertion into the Google Flow composer. Clipboard contents are not read, retained, or sent to the developer.

### cookies

Used only after the user clicks Clear cache. The extension identifies and removes cookies scoped to `flow.google.com` and `labs.google` so the user can reset a stuck Google Flow session. Cookie values are not stored, logged, or transmitted to the developer.

### debugger

Required for the extension's single automation purpose. While a queue is running on a user-selected Google Flow tab, the extension uses the Chrome Debugger Protocol to insert prompt text, dispatch user-requested keyboard and mouse input, manage the tab zoom needed for reliable controls, disable stale network cache, and clear site storage when the user explicitly requests Clear cache. It attaches only to the active `flow.google.com` or `labs.google` Flow tab and detaches when work ends or the tab closes. No debugger data is sent to the developer.

### downloads

Used when Auto download is enabled to save completed user-generated images and videos, apply the selected folder and filename rules, and monitor download completion. It does not read unrelated download contents.

### sidePanel

Used to provide the extension's queue, settings, run status, and diagnostics interface in Chrome's side panel.

### storage

Used for local-only persistence of settings, language, appearance, queue status, and diagnostic logs. The extension does not use sync storage or transmit this data to a developer server.

### Host permission: `https://flow.google.com/*` and `https://labs.google/*`

Required to detect Google Flow project pages, insert user-provided prompts and reference images, observe generation status, identify completed media requested by the user, and start optional downloads. The extension does not access other websites.

## Remote code

Select: No, I am not using remote code.

All executable JavaScript is bundled inside the extension package. The extension does not download or execute remote scripts, WebAssembly, or interpreted command code.

## Data categories

Conservative recommended disclosures:

- Website content: Yes
- Authentication information: Yes

Why:

- Website content includes prompts, user-selected images, Google Flow page controls, generation status, and generated-media URLs processed locally to provide the automation.
- Authentication information is disclosed because the Clear cache command accesses `flow.google.com` and `labs.google` cookies solely to delete them. Cookie values are never retained or transmitted.

All other categories: No, based on the current code.

## Data use certifications

Certify all applicable statements:

- Data is used only to provide the extension's single purpose.
- Data is not sold.
- Data is not used or transferred for purposes unrelated to the single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.
- Human access is not allowed except when required by law or explicitly requested by the user for support.

## Privacy policy

Enter this public URL:

`https://darkangel-04.github.io/flow-queue-site/PRIVACY_POLICY.html`
