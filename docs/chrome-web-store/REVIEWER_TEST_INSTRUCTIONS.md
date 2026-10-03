# Reviewer Test Instructions

## Account requirements

The extension requires access to Google Flow. Reviewers may use their own Google account with Google Flow access. The extension itself has no separate login, subscription, license key, or payment.

## Core test

1. Install the extension and open `https://flow.google.com`.
2. Open or create a Google Flow project.
3. Click the Flow Queue extension icon to open the side panel.
4. Confirm that the status changes to Connected and ready.
5. Select Text to image.
6. Enter two simple prompts, one per line.
7. Set Concurrent to 1 and Outputs to 1.
8. Leave Auto download enabled.
9. Click Run.
10. Confirm that each prompt receives progress and a final status in Runs.
11. Confirm that completed media is downloaded to the configured folder.

## Image workflow

1. Select Image to image or Image to video.
2. Click Add images and choose a local image.
3. Enter one prompt and click Run.
4. Confirm that the selected image is inserted into Google Flow and the run status updates.

## Manual-download behavior

1. Turn Auto download off.
2. Run one prompt.
3. Confirm that generation is monitored but the extension does not start a download.

## Permission-specific tests

- `downloads`: exercised by Auto download.
- `clipboardWrite`: exercised by Copy in Diagnostics and by reference-image insertion where required.
- `cookies`: exercised only by the explicit Clear cache button.
- `debugger`: exercised during queue execution for prompt insertion and user-requested interaction with Google Flow.
- `storage`: exercised by changing settings, closing the side panel, and reopening it.
- `sidePanel`: exercised by opening the extension.

## Notes for review

- The extension operates only on `flow.google.com` and `labs.google`.
- It contains no remote executable code.
- It sends no analytics or user content to a developer-operated server.
- Chrome may display its standard debugger notification while a queue is active because the extension uses the Chrome Debugger Protocol for automation.
