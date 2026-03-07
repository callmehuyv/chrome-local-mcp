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

// Element reference system — maps ref IDs to element info per page
const pageRefs = {};      // { pageId: { 'e1': { role, name, selector, ... }, ... } }
const prevSnapshots = {}; // { pageId: lastSnapshotText } for incremental diffs
let refCounter = 0;

function getPage(pageId) {
  const page = pages[pageId];
  if (!page) throw new Error(`Page ${pageId} not found. Available: ${Object.keys(pages).join(', ')}`);
  return page;
}

// Build YAML-like snapshot from Puppeteer accessibility tree with element refs
async function buildSnapshot(page, pageId) {
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
  if (!snapshot) return { text: '(empty page)', refs: {} };

  const refs = {};
  refCounter = 0;
  const lines = [];

  function renderNode(node, indent = 0) {
    const prefix = '  '.repeat(indent);
    const role = node.role || 'generic';
    const name = node.name || '';

    // Assign ref to interactive elements
    let refTag = '';
    const interactable = [
      'button', 'link', 'textbox', 'searchbox', 'combobox',
      'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
      'tab', 'menuitem', 'option', 'treeitem',
    ];
    if (interactable.includes(role) || node.focused) {
      const ref = 'e' + (++refCounter);
      refTag = ` [ref=${ref}]`;
      refs[ref] = { role, name, nodeInfo: node };
    }

    // Build state annotations
    const states = [];
    if (node.focused) states.push('focused');
    if (node.checked === true) states.push('checked');
    if (node.checked === 'mixed') states.push('mixed');
    if (node.disabled) states.push('disabled');
    if (node.expanded === true) states.push('expanded');
    if (node.expanded === false) states.push('collapsed');
    if (node.selected) states.push('selected');
    if (node.required) states.push('required');
    if (node.pressed) states.push('pressed');
    const stateStr = states.length ? ` [${states.join(', ')}]` : '';

    // Build the value display
    let valueStr = '';
    if (node.value !== undefined && node.value !== '') {
      valueStr = `: "${node.value}"`;
    }

    // Render line
    const nameStr = name ? ` "${name}"` : '';
    lines.push(`${prefix}- ${role}${nameStr}${refTag}${stateStr}${valueStr}`);

    // Recurse children
    if (node.children) {
      for (const child of node.children) {
        renderNode(child, indent + 1);
      }
    }
  }

  renderNode(snapshot);
  return { text: lines.join('\n'), refs };
}

// Resolve a ref to a DOM element handle
async function resolveRef(page, pageId, ref) {
  const refMap = pageRefs[pageId];
  if (!refMap || !refMap[ref]) throw new Error(`Ref "${ref}" not found. Take a new snapshot first.`);

  const info = refMap[ref];
  const { role, name } = info;

  // Build a selector strategy based on role + name
  const el = await page.evaluateHandle(({ role, name }) => {
    // Use ARIA role mapping to find the element
    const roleToSelectors = {
      button: ['button', 'input[type="button"]', 'input[type="submit"]', '[role="button"]'],
      link: ['a[href]', '[role="link"]'],
      textbox: ['input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input:not([type])', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
      searchbox: ['input[type="search"]', '[role="searchbox"]'],
      combobox: ['select', '[role="combobox"]'],
      checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
      radio: ['input[type="radio"]', '[role="radio"]'],
      switch: ['[role="switch"]'],
      slider: ['input[type="range"]', '[role="slider"]'],
      spinbutton: ['input[type="number"]', '[role="spinbutton"]'],
      tab: ['[role="tab"]'],
      menuitem: ['[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]'],
      option: ['option', '[role="option"]'],
      treeitem: ['[role="treeitem"]'],
    };

    const selectors = roleToSelectors[role] || [`[role="${role}"]`];
    for (const sel of selectors) {
      const elements = [...document.querySelectorAll(sel)];
      for (const el of elements) {
        // Match by accessible name (text content, aria-label, label, placeholder, value)
        const label = el.getAttribute('aria-label')
          || el.getAttribute('placeholder')
          || el.getAttribute('title')
          || (el.labels && el.labels[0] && el.labels[0].textContent.trim())
          || el.textContent.trim();
        if (name && label && label.includes(name)) return el;
        if (!name && el.offsetParent !== null) return el;
      }
    }
    return null;
  }, { role, name });

  const element = el.asElement();
  if (!element) throw new Error(`Could not find element for ref "${ref}" (${role} "${name}"). Page may have changed — take a new snapshot.`);
  return element;
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
server.tool('click', 'Click an element by ref (from snapshot), selector, text, or coordinates', {
  pageId: z.number().describe('Page ID'),
  ref: z.string().optional().describe('Element ref from snapshot (e.g. "e1") — preferred method'),
  selector: z.string().optional().describe('CSS selector'),
  text: z.string().optional().describe('Click element containing this exact text'),
  x: z.number().optional().describe('X coordinate'),
  y: z.number().optional().describe('Y coordinate'),
}, async ({ pageId, ref, selector, text, x, y }) => {
  const page = getPage(pageId);
  if (ref) {
    const element = await resolveRef(page, pageId, ref);
    await element.click();
    return { content: [{ type: 'text', text: `Clicked ref ${ref} (${pageRefs[pageId][ref].role} "${pageRefs[pageId][ref].name}")` }] };
  } else if (x !== undefined && y !== undefined) {
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
    throw new Error('Provide ref, selector, text, or x/y coordinates');
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

// Snapshot — accessibility tree with element refs (cheapest way to understand a page)
server.tool('snapshot', 'PREFERRED: Use this FIRST to understand page content. Returns accessibility tree with interactive element refs. Much cheaper than screenshots (text only, no vision tokens). Use refs with click_ref/type_ref. Only use screenshot if you need visual/layout context that the snapshot cannot provide.', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = getPage(pageId);
  const url = page.url();
  const title = await page.title();
  const { text, refs } = await buildSnapshot(page, pageId);

  // Store refs for this page
  pageRefs[pageId] = refs;

  const refCount = Object.keys(refs).length;
  const header = `### Page\n- URL: ${url}\n- Title: ${title}\n\n### Snapshot (${refCount} interactive elements)\n`;
  return { content: [{ type: 'text', text: header + text }] };
});

// Click by ref — use refs from snapshot for reliable element targeting
server.tool('click_ref', 'Click an element by its ref from a snapshot (e.g. "e3"). More reliable than CSS selectors.', {
  pageId: z.number().describe('Page ID'),
  ref: z.string().describe('Element ref from snapshot (e.g. "e1", "e3")'),
}, async ({ pageId, ref }) => {
  const page = getPage(pageId);
  const element = await resolveRef(page, pageId, ref);
  await element.click();
  return { content: [{ type: 'text', text: `Clicked ref ${ref} (${pageRefs[pageId][ref].role} "${pageRefs[pageId][ref].name}")` }] };
});

// Type by ref — type into an input identified by its ref
server.tool('type_ref', 'Type text into an element by its ref from a snapshot. More reliable than CSS selectors.', {
  pageId: z.number().describe('Page ID'),
  ref: z.string().describe('Element ref from snapshot (e.g. "e1")'),
  text: z.string().describe('Text to type'),
  clear: z.boolean().optional().describe('Clear field first'),
}, async ({ pageId, ref, text, clear }) => {
  const page = getPage(pageId);
  const element = await resolveRef(page, pageId, ref);
  if (clear) {
    await element.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
  }
  await element.type(text, { delay: 50 });
  return { content: [{ type: 'text', text: `Typed into ref ${ref} (${pageRefs[pageId][ref].role} "${pageRefs[pageId][ref].name}")` }] };
});

// Screenshot (with optional local OCR to save tokens)
server.tool('screenshot', 'Take a screenshot. IMPORTANT: Prefer snapshot tool first — it is cheaper (no vision tokens). Only use screenshot when you need visual context (layout, images, colors) that snapshot cannot provide. Use ocr=true to extract text locally instead of sending the image.', {
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

// Batch — run multiple actions in one call
server.tool('batch', 'Run multiple actions sequentially in one call. Saves round trips. Use snapshot first to get refs, then batch actions using those refs.', {
  pageId: z.number().describe('Page ID'),
  delayBetween: z.number().optional().describe('Delay in ms between each action (default: 100)'),
  actions: z.array(z.object({
    action: z.enum(['click', 'type', 'press_key', 'select', 'scroll', 'wait_for', 'navigate']).describe('Action to perform'),
    selector: z.string().optional().describe('CSS selector'),
    ref: z.string().optional().describe('Element ref from snapshot'),
    text: z.string().optional().describe('Text to type, or key to press, or URL to navigate'),
    value: z.string().optional().describe('Value for select'),
    clear: z.boolean().optional().describe('Clear field before typing'),
    x: z.number().optional().describe('X coordinate or horizontal scroll'),
    y: z.number().optional().describe('Y coordinate or vertical scroll'),
    delay: z.number().optional().describe('Delay in ms (for type keystroke delay, or wait_for timeout)'),
  })).describe('Array of actions to run sequentially'),
}, async ({ pageId, delayBetween, actions }) => {
  const gap = delayBetween ?? 100;
  const page = getPage(pageId);
  const results = [];

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    try {
      switch (a.action) {
        case 'click':
          if (a.ref) {
            const el = await resolveRef(page, pageId, a.ref);
            await el.click();
            results.push(`${i + 1}. Clicked ref ${a.ref}`);
          } else if (a.x !== undefined && a.y !== undefined) {
            await page.mouse.click(a.x, a.y);
            results.push(`${i + 1}. Clicked (${a.x}, ${a.y})`);
          } else if (a.selector) {
            await page.click(a.selector);
            results.push(`${i + 1}. Clicked ${a.selector}`);
          }
          break;
        case 'type':
          if (a.ref) {
            const el = await resolveRef(page, pageId, a.ref);
            if (a.clear) { await el.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); }
            await el.type(a.text || '', { delay: a.delay || 50 });
            results.push(`${i + 1}. Typed into ref ${a.ref}`);
          } else if (a.selector) {
            if (a.clear) { await page.click(a.selector, { clickCount: 3 }); await page.keyboard.press('Backspace'); }
            await page.type(a.selector, a.text || '', { delay: a.delay || 50 });
            results.push(`${i + 1}. Typed into ${a.selector}`);
          }
          break;
        case 'press_key':
          await page.keyboard.press(a.text || 'Enter');
          results.push(`${i + 1}. Pressed ${a.text || 'Enter'}`);
          break;
        case 'select':
          if (a.selector && a.value) {
            await page.select(a.selector, a.value);
            results.push(`${i + 1}. Selected ${a.value} in ${a.selector}`);
          }
          break;
        case 'scroll':
          await page.evaluate((sx, sy) => window.scrollBy(sx, sy), a.x || 0, a.y || 500);
          results.push(`${i + 1}. Scrolled`);
          break;
        case 'wait_for':
          if (a.selector) {
            await page.waitForSelector(a.selector, { timeout: a.delay || 10000, visible: true });
            results.push(`${i + 1}. Found ${a.selector}`);
          }
          break;
        case 'navigate':
          if (a.text) {
            await page.goto(a.text, { waitUntil: 'networkidle2', timeout: 30000 });
            results.push(`${i + 1}. Navigated to ${a.text}`);
          }
          break;
      }
      // Delay between actions
      if (i < actions.length - 1) {
        await new Promise(r => setTimeout(r, gap));
      }
    } catch (err) {
      results.push(`${i + 1}. ERROR (${a.action}): ${err.message}`);
      break; // Stop on first error
    }
  }

  return { content: [{ type: 'text', text: results.join('\n') }] };
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
