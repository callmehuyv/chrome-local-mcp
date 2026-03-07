#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const USER_DATA_DIR = path.join(os.homedir(), '.chrome-local-mcp-profile');

// Local OCR using Apple Vision framework (macOS only)
function localOCR(imagePath) {
  return new Promise((resolve, reject) => {
    const script = `
import Vision, sys
from Foundation import NSURL

url = NSURL.fileURLWithPath_(sys.argv[1])
req = Vision.VNRecognizeTextRequest.alloc().init()
req.setRecognitionLevel_(0)
req.setRecognitionLanguages_(["en", "vi"])
handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)
ok, err = handler.performRequests_error_([req], None)
if not ok:
    print("OCR_ERROR: " + str(err), file=sys.stderr)
    sys.exit(1)
for r in req.results():
    print(r.text())
`;
    execFile('python3', ['-c', script, imagePath], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`OCR failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

let browser = null;
let pages = {};
let pageCounter = 0;

function getPage(pageId) {
  const page = pages[pageId];
  if (!page) throw new Error(`Page ${pageId} not found. Available: ${Object.keys(pages).join(', ')}`);
  return page;
}

const server = new McpServer({
  name: 'chrome-local',
  version: '1.0.0',
});

// Launch browser
server.tool('launch', 'Launch Chrome browser', {
  headless: z.boolean().optional().describe('Run headless (default: false)'),
}, async ({ headless }) => {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    defaultViewport: null,
    userDataDir: USER_DATA_DIR,
    args: ['--window-size=1440,900', '--no-sandbox'],
  });
  pages = {};
  pageCounter = 0;
  const [defaultPage] = await browser.pages();
  const id = ++pageCounter;
  pages[id] = defaultPage;
  return { content: [{ type: 'text', text: JSON.stringify({ pageId: id, message: 'Browser launched' }) }] };
});

// Close browser
server.tool('close_browser', 'Close the browser', {}, async () => {
  if (browser) { await browser.close(); browser = null; pages = {}; }
  return { content: [{ type: 'text', text: 'Browser closed' }] };
});

// New tab
server.tool('new_tab', 'Open a new tab', {}, async () => {
  if (!browser) throw new Error('Browser not launched. Call launch first.');
  const page = await browser.newPage();
  const id = ++pageCounter;
  pages[id] = page;
  return { content: [{ type: 'text', text: JSON.stringify({ pageId: id }) }] };
});

// List pages
server.tool('list_pages', 'List all open pages/tabs', {}, async () => {
  const list = [];
  for (const [id, page] of Object.entries(pages)) {
    list.push({ pageId: Number(id), url: page.url(), title: await page.title() });
  }
  return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
});

// Navigate
server.tool('navigate', 'Navigate to a URL', {
  pageId: z.number().describe('Page ID'),
  url: z.string().describe('URL to navigate to'),
}, async ({ pageId, url }) => {
  const page = getPage(pageId);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return { content: [{ type: 'text', text: JSON.stringify({ url: page.url(), title: await page.title() }) }] };
});

// Click
server.tool('click', 'Click an element by selector, text, or coordinates', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().optional().describe('CSS selector'),
  text: z.string().optional().describe('Click element containing this exact text'),
  x: z.number().optional().describe('X coordinate'),
  y: z.number().optional().describe('Y coordinate'),
}, async ({ pageId, selector, text, x, y }) => {
  const page = getPage(pageId);
  if (x !== undefined && y !== undefined) {
    await page.mouse.click(x, y);
  } else if (text) {
    const el = await page.evaluateHandle((t) => {
      const elements = [...document.querySelectorAll('*')];
      return elements.find(e => e.textContent.trim() === t && e.offsetParent !== null);
    }, text);
    const element = el.asElement();
    if (!element) throw new Error(`No element with text "${text}" found`);
    await element.click();
  } else if (selector) {
    await page.click(selector);
  } else {
    throw new Error('Provide selector, text, or x/y coordinates');
  }
  return { content: [{ type: 'text', text: 'Clicked' }] };
});

// Type
server.tool('type', 'Type text into an element', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().describe('CSS selector of input'),
  text: z.string().describe('Text to type'),
  clear: z.boolean().optional().describe('Clear field first'),
  delay: z.number().optional().describe('Delay between keystrokes in ms'),
}, async ({ pageId, selector, text, clear, delay }) => {
  const page = getPage(pageId);
  if (clear) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
  }
  await page.type(selector, text, { delay: delay || 50 });
  return { content: [{ type: 'text', text: 'Typed' }] };
});

// Press key
server.tool('press_key', 'Press a keyboard key', {
  pageId: z.number().describe('Page ID'),
  key: z.string().describe('Key to press (e.g. Enter, Tab, Escape)'),
}, async ({ pageId, key }) => {
  const page = getPage(pageId);
  await page.keyboard.press(key);
  return { content: [{ type: 'text', text: `Pressed ${key}` }] };
});

// Screenshot (with optional local OCR to save tokens)
server.tool('screenshot', 'Take a screenshot. Use ocr=true to extract text locally instead of sending the image (saves tokens)', {
  pageId: z.number().describe('Page ID'),
  path: z.string().optional().describe('File path to save (default: /tmp/screenshot-<timestamp>.png)'),
  fullPage: z.boolean().optional().describe('Capture full page'),
  ocr: z.boolean().optional().describe('Run local OCR and return text instead of image (saves tokens)'),
}, async ({ pageId, path, fullPage, ocr }) => {
  const page = getPage(pageId);
  const filePath = path || `/tmp/screenshot-${Date.now()}.png`;
  // Save to file (binary) — do NOT mix with encoding: 'base64' or the file gets corrupted
  await page.screenshot({ path: filePath, fullPage: fullPage || false });
  if (ocr) {
    const text = await localOCR(filePath);
    return {
      content: [
        { type: 'text', text: `Screenshot saved to ${filePath}\n\n--- OCR Text (local Vision) ---\n${text}` },
      ],
    };
  }
  // Read back as base64 for returning the image to Claude
  const fs = require('fs');
  const base64 = fs.readFileSync(filePath).toString('base64');
  return {
    content: [
      { type: 'text', text: `Screenshot saved to ${filePath}` },
      { type: 'image', data: base64, mimeType: 'image/png' },
    ],
  };
});

// OCR - extract text from any image using local Apple Vision
server.tool('ocr', 'Extract text from an image file using local Apple Vision OCR (no tokens sent to cloud)', {
  imagePath: z.string().describe('Absolute path to the image file'),
}, async ({ imagePath }) => {
  const text = await localOCR(imagePath);
  return { content: [{ type: 'text', text: text || '(no text detected)' }] };
});

// Get page text
server.tool('get_text', 'Get text content of the page or a specific element', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().optional().describe('CSS selector (default: entire body)'),
}, async ({ pageId, selector }) => {
  const page = getPage(pageId);
  let text;
  if (selector) {
    text = await page.$eval(selector, el => el.textContent);
  } else {
    text = await page.evaluate(() => document.body.innerText);
  }
  return { content: [{ type: 'text', text }] };
});

// Execute JavaScript
server.tool('eval', 'Execute JavaScript on the page', {
  pageId: z.number().describe('Page ID'),
  script: z.string().describe('JavaScript code to execute'),
}, async ({ pageId, script }) => {
  const page = getPage(pageId);
  const fn = new Function(`return (async () => { ${script} })()`);
  const result = await page.evaluate(script);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// Wait for selector
server.tool('wait_for', 'Wait for an element to appear', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().describe('CSS selector to wait for'),
  timeout: z.number().optional().describe('Timeout in ms (default: 10000)'),
}, async ({ pageId, selector, timeout }) => {
  const page = getPage(pageId);
  await page.waitForSelector(selector, { timeout: timeout || 10000, visible: true });
  return { content: [{ type: 'text', text: `Found: ${selector}` }] };
});

// Scroll
server.tool('scroll', 'Scroll the page', {
  pageId: z.number().describe('Page ID'),
  x: z.number().optional().describe('Horizontal scroll (default: 0)'),
  y: z.number().optional().describe('Vertical scroll (default: 500)'),
}, async ({ pageId, x, y }) => {
  const page = getPage(pageId);
  await page.evaluate((sx, sy) => window.scrollBy(sx, sy), x || 0, y || 500);
  return { content: [{ type: 'text', text: 'Scrolled' }] };
});

// Get all links
server.tool('get_links', 'Get all links on the page', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = getPage(pageId);
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim(), href: a.href }))
  );
  return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] };
});

// Get form inputs
server.tool('get_inputs', 'Get all form inputs on the page', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = getPage(pageId);
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')].map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      value: el.value,
    }))
  );
  return { content: [{ type: 'text', text: JSON.stringify(inputs, null, 2) }] };
});

// Select dropdown
server.tool('select', 'Select a dropdown option', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().describe('CSS selector of select element'),
  value: z.string().describe('Value to select'),
}, async ({ pageId, selector, value }) => {
  const page = getPage(pageId);
  await page.select(selector, value);
  return { content: [{ type: 'text', text: `Selected ${value}` }] };
});

// Go back/forward
server.tool('go_back', 'Go back in browser history', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = getPage(pageId);
  await page.goBack({ waitUntil: 'networkidle2' });
  return { content: [{ type: 'text', text: JSON.stringify({ url: page.url(), title: await page.title() }) }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Chrome Local MCP server running on stdio');
}

main().catch(console.error);
