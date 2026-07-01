# gancao-copliot

This is a Chrome Extension built with Manifest V3.

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right corner.
3. Click "Load unpacked" and select this folder.

## Structure

- `manifest.json`: The configuration file.
- `popup.html/js`: The UI shown when clicking the extension icon.
- `background.js`: The background service worker.
- `content.js`: Scripts that run on web pages.