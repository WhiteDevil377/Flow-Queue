# Chrome Web Store Submission Checklist

## Developer account

- [ ] Register at the Chrome Web Store Developer Dashboard.
- [ ] Pay the one-time registration fee.
- [ ] Enable 2-Step Verification on the publishing Google account.
- [ ] Complete the developer profile and verify the contact email.
- [ ] Use a publisher name you own and can support long term.

## External pages

- [ ] Replace every placeholder in `PRIVACY_POLICY.html`.
- [x] Privacy policy hosted at `https://darkangel-04.github.io/flow-queue-site/PRIVACY_POLICY.html`.
- [x] Homepage hosted at `https://darkangel-04.github.io/flow-queue-site/`.
- [x] Support page hosted at `https://darkangel-04.github.io/flow-queue-site/SUPPORT.html`.
- [ ] Verify the official domain in Google Search Console if you want verified-publisher status.

## Package

- [ ] Run `npm run release`.
- [ ] Upload `release/flow-queue-1.0.0-chrome-web-store.zip`.
- [ ] Keep `release/SHA256SUMS.txt` for your release records.
- [ ] Never upload the repository, `src`, `node_modules`, or a parent folder containing source code.

## Store Listing tab

- [ ] Paste the item name, summary, and detailed description from `STORE_LISTING.md`.
- [ ] Select Productivity.
- [ ] Upload `store-assets/ready/icon-128.png`.
- [ ] Upload both 1280x800 screenshots.
- [ ] Upload `store-assets/ready/small-promo-440x280.png`.
- [ ] Optionally upload the 1400x560 marquee image.
- [ ] Add the homepage and support URLs.

## Privacy tab

- [ ] Paste the single-purpose statement from `PRIVACY_DASHBOARD.md`.
- [ ] Paste every permission justification exactly and adjust only if functionality changes.
- [ ] Declare no remote code.
- [ ] Disclose Website content and Authentication information.
- [ ] Complete the Limited Use certifications.
- [ ] Enter the hosted privacy-policy URL.

## Distribution tab

- [ ] Declare no in-app purchases unless monetization is added later.
- [ ] Start as Private or Unlisted for final testing.
- [ ] Select the intended countries or All regions.
- [ ] Move to Public only after installation and generation tests pass from the Web Store build.

## Test instructions tab

- [ ] Paste `REVIEWER_TEST_INSTRUCTIONS.md`.
- [ ] Do not provide personal Google credentials.
- [ ] If Google Flow later requires a paid or restricted account, provide a dedicated reviewer account through the dashboard's secure credentials fields.

## Final checks

- [ ] Install the exact ZIP as an unpacked copy by extracting it to a clean folder.
- [ ] Test text-to-image, text-to-video, image-to-image, and image-to-video.
- [ ] Test Auto download on and off.
- [ ] Test Clear cache and Clear logs.
- [ ] Confirm there are no errors at `chrome://extensions`.
- [ ] Confirm the privacy policy and listing match the released code.
- [ ] Submit with deferred publishing for the first release so approval can be inspected before going live.
