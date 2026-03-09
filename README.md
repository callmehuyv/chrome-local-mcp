<div align="center">

# Chrome Local MCP

**Give Claude Code full control over a real Chrome browser.**

Navigate pages, click elements, fill forms, take screenshots, extract text — all locally, no cloud needed.

[![npm version](https://img.shields.io/npm/v/chrome-local-mcp?color=blue&label=npm)](https://www.npmjs.com/package/chrome-local-mcp)
[![npm downloads](https://img.shields.io/npm/dw/chrome-local-mcp?color=green&label=downloads)](https://www.npmjs.com/package/chrome-local-mcp)
[![license](https://img.shields.io/npm/l/chrome-local-mcp?color=purple)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/callmehuyv/chrome-local-mcp?style=social)](https://github.com/callmehuyv/chrome-local-mcp)

</div>

---

## Install in 10 seconds

```bash
claude mcp add chrome_local -- npx chrome-local-mcp@latest
```

Restart Claude Code. Done. The `mcp__chrome_local__*` tools are ready.

> **That's it.** No global install, no config files, no browser flags. Just one command.

---

## What can it do?

Just talk to Claude Code naturally:

```
> Open Chrome and go to github.com
> Take a snapshot of the page
> Click the "Sign in" button
> Fill in the username field with "myuser"
> Take a screenshot with OCR
> Get all the links on this page
```

Claude Code picks the right MCP tool automatically.

---

## Why Chrome Local MCP?

Most browser MCPs (Playwright MCP, Chrome DevTools MCP) are built for general-purpose automation. **Chrome Local MCP is built for how Claude Code actually works** — fast, token-efficient, and practical.

| | Chrome Local MCP | Playwright MCP | Chrome DevTools MCP |
|---|:---:|:---:|:---:|
| **Persistent sessions** (stays logged in) | **Yes** | No | No |
| **Accessibility snapshots** (no vision tokens) | **Yes** | Yes | No |
| **Element refs** for reliable clicking | **Yes** | Yes | No |
| **Local OCR** via Apple Vision (zero cost) | **Yes** | No | No |
| **Batch actions** in a single tool call | **Yes** | No | No |
| **Visible browser** (see what Claude does) | **Yes** | Configurable | Yes |
| **Works with your real Chrome profile** | **Yes** | No | Partial |
| **REST API** for external integrations | **Yes** | No | No |
| **Zero config** — just install and go | **Yes** | Yes | Requires flags |

### Highlights

- **Persistent browser profile** — Log into a site once, Claude can access it every time. No re-authentication between sessions.
- **Local OCR saves tokens** — Extract text from screenshots locally using Apple Vision. Saves 2,000-5,000 vision tokens per screenshot.
- **Batch actions** — Chain click, type, scroll, navigate in a single tool call. Fewer round trips, faster workflows.
- **Real Chrome** — Not a sandboxed test browser. Extensions, profiles, and site compatibility just work.
- **Simple architecture** — One file, stdio transport, no sidecar processes, no browser extensions. Just works.

---

## Installation Options

### Option A: npx (Recommended)

No install needed. Just register with Claude Code:

```bash
claude mcp add chrome_local -- npx chrome-local-mcp@latest
```

### Option B: Global install

```bash
npm install -g chrome-local-mcp
claude mcp add --scope user chrome_local chrome-local-mcp
```

### Option C: From source

```bash
git clone https://github.com/callmehuyv/chrome-local-mcp.git
cd chrome-local-mcp
npm install
claude mcp add --scope user chrome_local node /path/to/chrome-local-mcp/mcp-server.js
```

> After any install method, **restart Claude Code** to pick up the new tools.

---

## Available Tools (22)

| Tool | What it does |
|------|-------------|
| `launch` | Launch Chrome (visible or headless) |
| `close_browser` | Close the browser |
| `new_tab` | Open a new tab |
| `list_pages` | List all open tabs |
| `navigate` | Go to a URL |
| `go_back` | Go back in history |
| `snapshot` | Get accessibility tree with element refs (cheapest way to read a page) |
| `click` | Click by selector, text, or coordinates |
| `click_ref` | Click an element by its snapshot ref |
| `type` | Type text into an input |
| `type_ref` | Type into an element by its snapshot ref |
| `press_key` | Press a keyboard key (Enter, Tab, Escape, etc.) |
| `select` | Select a dropdown option |
| `scroll` | Scroll the page |
| `screenshot` | Take a screenshot (with optional local OCR) |
| `ocr` | Extract text from any image file via Apple Vision |
| `get_text` | Get text content of the page or element |
| `get_links` | Get all links on the page |
| `get_inputs` | Get all form inputs |
| `eval` | Execute JavaScript on the page |
| `wait_for` | Wait for an element to appear |
| `batch` | Run multiple actions in a single tool call |

---

## Accessibility Snapshots — Your Secret Weapon

The `snapshot` tool is the **cheapest and fastest** way to understand a page. No screenshots, no vision tokens, no OCR. Just a structured text tree:

```
> Take a snapshot of the page

- RootWebArea "Example Domain"
  - heading "Example Domain"
  - StaticText "This domain is for use in..."
  - link "Learn more" [ref=e1]
```

Each interactive element gets a **ref** (e.g. `[ref=e1]`). Use it to click or type:

```
> Click ref e1
> Type "hello" into ref e3
```

### Cost comparison

| Method | Token cost | Speed |
|--------|-----------|-------|
| `snapshot` | ~100-500 text tokens | Instant |
| `screenshot` with `ocr: true` | ~500-2,000 text tokens | ~1.4s |
| `screenshot` (image) | ~2,000-5,000 vision tokens | Instant |

**Always try `snapshot` first.** Use screenshots only when you need visual context.

---

## Local OCR (macOS)

Extract text from screenshots locally — no tokens spent sending images to Claude:

```
> Take a screenshot with OCR
> OCR this image: /tmp/my-image.png
```

**Requirements:**
- macOS (uses Apple Vision framework)
- Python 3 with:
  ```bash
  pip3 install pyobjc-framework-Vision pyobjc-framework-Quartz
  ```

---

## How It Works

```
Claude Code  ←— stdio —→  MCP Server  ←———→  Puppeteer  ←———→  Chrome
```

1. Claude Code sends tool calls via MCP protocol (stdio)
2. `mcp-server.js` translates them into Puppeteer commands
3. Puppeteer controls a local Chrome instance
4. Chrome opens in visible mode so you can see what's happening

---

## REST API (Optional)

An HTTP API server is included for programmatic control outside Claude Code:

```bash
npm run server   # starts on http://localhost:3033
```

```bash
curl -X POST http://localhost:3033/launch
curl -X POST http://localhost:3033/navigate \
  -H 'Content-Type: application/json' \
  -d '{"pageId": 1, "url": "https://example.com"}'
curl -X POST http://localhost:3033/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"pageId": 1}'
```

See `server.js` for all endpoints.

---

## Configuration

### Headless mode

```
> Launch Chrome in headless mode
```

### Window size

Default: 1440x900. Edit `mcp-server.js` to change the `--window-size` arg.

---

## Requirements

- Node.js 18+
- Chrome/Chromium (Puppeteer downloads one automatically if needed)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

---

## Troubleshooting

**MCP tools not showing up?**
1. Check registration: `claude mcp list`
2. Restart Claude Code (new session)
3. Verify the path points to the correct `mcp-server.js`

**Browser not launching?**
- Close any other Puppeteer/Chrome automation instances
- Run `npm install` to re-download Chrome
- macOS: Allow Chrome in System Preferences > Privacy & Security

**Screenshots not returning images?**
- Use a Claude Code model that supports images
- Screenshots save to `/tmp/` — check the file path in the response

---

## Contributing

Found a bug or have a feature request? [Open an issue](https://github.com/callmehuyv/chrome-local-mcp/issues) — we'd love to hear from you.

If this project helps you, consider giving it a star — it helps others discover it too.

[![Star History Chart](https://api.star-history.com/svg?repos=callmehuyv/chrome-local-mcp&type=Date)](https://star-history.com/#callmehuyv/chrome-local-mcp&Date)

---

## License

MIT
