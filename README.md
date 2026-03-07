# Chrome Local MCP

A local Chrome browser automation server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and [Puppeteer](https://pptr.dev/).

This gives Claude Code full control over a local Chrome browser — navigate pages, click elements, fill forms, take screenshots, run JavaScript, and more. No permission prompts, no cloud dependencies. Everything runs locally on your machine.

## Quick Start

### 1. Install

```bash
git clone https://github.com/callmehuyv/chrome-local-mcp.git
cd chrome-local-mcp
npm install
```

### 2. Register with Claude Code

**For all projects (recommended):**

```bash
claude mcp add --scope user chrome_local node /path/to/chrome-local-mcp/mcp-server.js
```

**For a single project:**

```bash
claude mcp add chrome_local node /path/to/chrome-local-mcp/mcp-server.js
```

### 3. Restart Claude Code

Start a new Claude Code session. The `mcp__chrome_local__*` tools will be available automatically.

## Available Tools

| Tool | Description |
|------|-------------|
| `launch` | Launch Chrome browser (visible or headless) |
| `close_browser` | Close the browser |
| `new_tab` | Open a new tab |
| `list_pages` | List all open tabs with URLs and titles |
| `navigate` | Navigate to a URL |
| `click` | Click by CSS selector, text content, or x/y coordinates |
| `type` | Type text into an input field (with optional clear) |
| `press_key` | Press a keyboard key (Enter, Tab, Escape, etc.) |
| `screenshot` | Take a screenshot (returns image to Claude, or use `ocr: true` for local text extraction) |
| `ocr` | Extract text from any image file using local Apple Vision OCR (no cloud tokens) |
| `get_text` | Get text content of the page or a specific element |
| `get_links` | Get all links on the page |
| `get_inputs` | Get all form inputs on the page |
| `eval` | Execute JavaScript on the page |
| `wait_for` | Wait for an element to appear |
| `scroll` | Scroll the page |
| `select` | Select a dropdown option |
| `go_back` | Go back in browser history |

## Usage Examples

Once registered, just ask Claude Code to interact with web pages:

```
> Launch Chrome and go to github.com

> Take a screenshot of the current page

> Click the "Sign in" button

> Fill in the username field with "myuser"

> Get all the links on this page
```

Claude Code will use the MCP tools automatically based on your instructions.

## How It Works

```
Claude Code  <--stdio-->  MCP Server (mcp-server.js)  <---->  Puppeteer  <---->  Chrome
```

- **Claude Code** sends tool calls via the MCP protocol over stdio
- **mcp-server.js** receives the calls and translates them into Puppeteer commands
- **Puppeteer** controls a local Chrome instance
- **Chrome** opens in visible mode by default so you can see what's happening

## REST API Server (Optional)

An Express-based REST API server (`server.js`) is also included if you prefer HTTP-based control:

```bash
npm run server
```

This starts a server on `http://localhost:3033` with endpoints like:

```bash
# Launch browser
curl -X POST http://localhost:3033/launch

# Navigate
curl -X POST http://localhost:3033/navigate \
  -H 'Content-Type: application/json' \
  -d '{"pageId": 1, "url": "https://example.com"}'

# Screenshot
curl -X POST http://localhost:3033/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"pageId": 1}'

# Get page text
curl -X POST http://localhost:3033/text \
  -H 'Content-Type: application/json' \
  -d '{"pageId": 1}'
```

See `server.js` for all available endpoints.

## Configuration

### Headless Mode

By default, Chrome opens in visible mode. To run headless:

```
> Launch Chrome in headless mode
```

Or via the REST API:

```bash
curl -X POST http://localhost:3033/launch \
  -H 'Content-Type: application/json' \
  -d '{"headless": true}'
```

### Window Size

Default window size is 1440x900. To change it, edit `mcp-server.js` and modify the `--window-size` arg in the `launch` tool.

## Local OCR (macOS)

The `screenshot` tool supports an `ocr` parameter that runs text extraction locally using Apple's Vision framework instead of sending the image to Claude. This saves significant token costs when you only need the text content.

```
> Take a screenshot with OCR (no image sent to Claude)
> screenshot(pageId: 1, ocr: true)
```

The standalone `ocr` tool can also extract text from any image file on disk:

```
> OCR this image: /tmp/my-image.png
```

**Requirements for OCR:**
- macOS (uses Apple Vision framework)
- Python 3 with `pyobjc-framework-Vision` and `pyobjc-framework-Quartz`:
  ```bash
  pip3 install pyobjc-framework-Vision pyobjc-framework-Quartz
  ```

**When to use what:**
- `ocr: true` — You only need the text from the page (fast, free)
- Default screenshot — You need Claude to understand layout, visuals, or context (costs vision tokens)

## Requirements

- Node.js 18+
- Chrome/Chromium (Puppeteer will download one if not found)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## Troubleshooting

### MCP tools not showing up

1. Make sure you registered the server: `claude mcp list`
2. Restart Claude Code (start a new session)
3. Check the path in the registration points to the correct `mcp-server.js`

### Browser not launching

- Ensure no other Puppeteer instance is running
- Try `npm install` again to re-download Chrome
- On macOS, you may need to allow Chrome in System Preferences > Privacy & Security

### Screenshots not returning images

- Make sure you're using Claude Code with a model that supports images
- Screenshots are saved to `/tmp/` by default — check the file path in the response

## License

MIT
