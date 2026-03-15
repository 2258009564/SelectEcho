# SelectEcho (English Guide)

SelectEcho is a text-selection translation extension for Chrome/Edge (Manifest V3).
Select text with your left mouse button, release, and you get translation near the selection.

If you want to test the core feature quickly after installation, start with the section below.

## What's New in v1.1.1

- Left-click the extension toolbar icon to open settings directly.
- Added a subtle GitHub Star link in the settings page corner.
- Added a compact GitHub Star link inside each translation panel.

## 2-Minute Quick Test

1. Open your extension page.
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this project folder.
4. Open any normal `http/https` webpage and refresh it once (`Ctrl + R`).
5. Select an English sentence with the left mouse button and release.
6. Confirm the translation panel appears near your selection.
7. Need to configure engine/API? Left-click the SelectEcho toolbar icon to open settings directly.

Expected result:

- Panel shows status and translated text.
- Press `Esc` to close the panel.
- Click the copy button to copy current translation.
- A small GitHub Star link is shown at the bottom of the translation panel.

## Quick Setup (No API Key Needed)

To validate the feature first, you can use the default path:

- Engine mode: `auto`
- Baidu App ID: empty
- Baidu Key: empty

In this setup, SelectEcho will use Google endpoint directly.

## Optional AI Translation Test

If you want higher quality translation:

1. Left-click the SelectEcho toolbar icon to open extension options.
2. Set engine mode to `ai`.
3. Pick a preset (`OpenAI`, `DeepSeek`, or `Zhipu Flash Free`).
4. Fill in your API key.
5. Keep stream output enabled for long text.

The settings page also includes a tiny GitHub Star link in the bottom-right corner.

## Troubleshooting

### Nothing happens after text selection

- Refresh the webpage after loading or updating the extension.
- Test on regular websites only (`http/https`).
- `chrome://*`, `edge://*`, and extension pages are not supported.
- Selection inside `input`, `textarea`, or `contenteditable` is ignored by design.

### It says translation was skipped

- If source text is Simplified Chinese and target is `zh-CN`, skip is expected behavior.
- Traditional Chinese will still be translated into Simplified Chinese.

### Google request failed

- Check network access to Google Translate endpoint.
- If your network blocks Google, switch to `baidu` mode (with valid credentials) or use `ai` mode.

## Supported Browsers

- Chrome (Manifest V3)
- Microsoft Edge (Manifest V3)

## Project Files

- `manifest.json`: extension manifest and permissions
- `background.js`: translation routing and engine logic
- `content.js`: text selection listener and translation panel rendering
- `options.html` / `options.css` / `options.js`: settings page

## Release Package

- Latest release page: <https://github.com/2258009564/SelectEcho/releases>
- Latest stable ZIP: <https://github.com/2258009564/SelectEcho/releases/latest/download/SelectEcho.zip>

## License

MIT License. See `LICENSE`.
