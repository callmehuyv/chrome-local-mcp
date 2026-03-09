#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const { BrowserManager, CONFIG, localOCR } = require('./browser-manager');

const mgr = new BrowserManager();

const server = new McpServer({
  name: 'chrome-local',
  version: '1.0.0',
});

// --- Browser lifecycle ---

server.tool('launch', 'Launch Chrome browser', {
  headless: z.boolean().optional().describe('Run headless (default: false)'),
}, async ({ headless }) => {
  const pageId = await mgr.launch(headless);
  return { content: [{ type: 'text', text: JSON.stringify({ pageId, message: 'Browser launched' }) }] };
});

server.tool('close_browser', 'Close the browser', {}, async () => {
  await mgr.close();
  return { content: [{ type: 'text', text: 'Browser closed' }] };
});

server.tool('new_tab', 'Open a new tab', {}, async () => {
  const pageId = await mgr.newTab();
  return { content: [{ type: 'text', text: JSON.stringify({ pageId }) }] };
});

server.tool('list_pages', 'List all open pages/tabs', {}, async () => {
  const list = await mgr.listPages();
  return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
});

// --- Navigation ---

server.tool('navigate', 'Navigate to a URL', {
  pageId: z.number().describe('Page ID'),
  url: z.string().describe('URL to navigate to'),
}, async ({ pageId, url }) => {
  const page = mgr.getPage(pageId);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.NAVIGATION_TIMEOUT });
  return { content: [{ type: 'text', text: JSON.stringify({ url: page.url(), title: await page.title() }) }] };
});

server.tool('go_back', 'Go back in browser history', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = mgr.getPage(pageId);
  await page.goBack({ waitUntil: 'networkidle2' });
  return { content: [{ type: 'text', text: JSON.stringify({ url: page.url(), title: await page.title() }) }] };
});

// --- Snapshot & refs ---

server.tool('snapshot', 'PREFERRED: Use this FIRST to understand page content. Returns accessibility tree with interactive element refs. Much cheaper than screenshots (text only, no vision tokens). Use refs with click_ref/type_ref. Only use screenshot if you need visual/layout context that the snapshot cannot provide.', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = mgr.getPage(pageId);
  const url = page.url();
  const title = await page.title();
  const { text, refs } = await mgr.buildSnapshot(page, pageId);
  mgr.storeRefs(pageId, refs);

  const refCount = Object.keys(refs).length;
  const header = `### Page\n- URL: ${url}\n- Title: ${title}\n\n### Snapshot (${refCount} interactive elements)\n`;
  return { content: [{ type: 'text', text: header + text }] };
});

server.tool('click_ref', 'Click an element by its ref from a snapshot (e.g. "e3"). More reliable than CSS selectors.', {
  pageId: z.number().describe('Page ID'),
  ref: z.string().describe('Element ref from snapshot (e.g. "e1", "e3")'),
}, async ({ pageId, ref }) => {
  const page = mgr.getPage(pageId);
  const element = await mgr.resolveRef(page, pageId, ref);
  await element.click();
  const info = mgr.getRefInfo(pageId, ref);
  return { content: [{ type: 'text', text: `Clicked ref ${ref} (${info.role} "${info.name}")` }] };
});

server.tool('type_ref', 'Type text into an element by its ref from a snapshot. More reliable than CSS selectors.', {
  pageId: z.number().describe('Page ID'),
  ref: z.string().describe('Element ref from snapshot (e.g. "e1")'),
  text: z.string().describe('Text to type'),
  clear: z.boolean().optional().describe('Clear field first'),
}, async ({ pageId, ref, text, clear }) => {
  const page = mgr.getPage(pageId);
  const element = await mgr.resolveRef(page, pageId, ref);
  if (clear) await mgr.clearField(page, element);
  await element.type(text, { delay: CONFIG.DEFAULT_TYPING_DELAY });
  const info = mgr.getRefInfo(pageId, ref);
  return { content: [{ type: 'text', text: `Typed into ref ${ref} (${info.role} "${info.name}")` }] };
});

// --- Interaction ---

server.tool('click', 'Click an element by ref (from snapshot), selector, text, or coordinates', {
  pageId: z.number().describe('Page ID'),
  ref: z.string().optional().describe('Element ref from snapshot (e.g. "e1") — preferred method'),
  selector: z.string().optional().describe('CSS selector'),
  text: z.string().optional().describe('Click element containing this exact text'),
  x: z.number().optional().describe('X coordinate'),
  y: z.number().optional().describe('Y coordinate'),
}, async ({ pageId, ref, selector, text, x, y }) => {
  const page = mgr.getPage(pageId);
  if (ref) {
    const element = await mgr.resolveRef(page, pageId, ref);
    await element.click();
    const info = mgr.getRefInfo(pageId, ref);
    return { content: [{ type: 'text', text: `Clicked ref ${ref} (${info.role} "${info.name}")` }] };
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

server.tool('type', 'Type text into an element', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().describe('CSS selector of input'),
  text: z.string().describe('Text to type'),
  clear: z.boolean().optional().describe('Clear field first'),
  delay: z.number().optional().describe('Delay between keystrokes in ms'),
}, async ({ pageId, selector, text, clear, delay }) => {
  const page = mgr.getPage(pageId);
  if (clear) await mgr.clearField(page, selector);
  await page.type(selector, text, { delay: delay || CONFIG.DEFAULT_TYPING_DELAY });
  return { content: [{ type: 'text', text: 'Typed' }] };
});

server.tool('press_key', 'Press a keyboard key', {
  pageId: z.number().describe('Page ID'),
  key: z.string().describe('Key to press (e.g. Enter, Tab, Escape)'),
}, async ({ pageId, key }) => {
  const page = mgr.getPage(pageId);
  await page.keyboard.press(key);
  return { content: [{ type: 'text', text: `Pressed ${key}` }] };
});

server.tool('select', 'Select a dropdown option', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().describe('CSS selector of select element'),
  value: z.string().describe('Value to select'),
}, async ({ pageId, selector, value }) => {
  const page = mgr.getPage(pageId);
  await page.select(selector, value);
  return { content: [{ type: 'text', text: `Selected ${value}` }] };
});

server.tool('scroll', 'Scroll the page', {
  pageId: z.number().describe('Page ID'),
  x: z.number().optional().describe('Horizontal scroll (default: 0)'),
  y: z.number().optional().describe('Vertical scroll (default: 500)'),
}, async ({ pageId, x, y }) => {
  const page = mgr.getPage(pageId);
  await page.evaluate((sx, sy) => window.scrollBy(sx, sy), x || 0, y || CONFIG.DEFAULT_SCROLL_Y);
  return { content: [{ type: 'text', text: 'Scrolled' }] };
});

server.tool('wait_for', 'Wait for an element to appear', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().describe('CSS selector to wait for'),
  timeout: z.number().optional().describe('Timeout in ms (default: 10000)'),
}, async ({ pageId, selector, timeout }) => {
  const page = mgr.getPage(pageId);
  await page.waitForSelector(selector, { timeout: timeout || CONFIG.WAIT_TIMEOUT, visible: true });
  return { content: [{ type: 'text', text: `Found: ${selector}` }] };
});

// --- Inspection ---

server.tool('get_text', 'Get text content of the page or a specific element', {
  pageId: z.number().describe('Page ID'),
  selector: z.string().optional().describe('CSS selector (default: entire body)'),
}, async ({ pageId, selector }) => {
  const page = mgr.getPage(pageId);
  const text = selector
    ? await page.$eval(selector, el => el.textContent)
    : await page.evaluate(() => document.body.innerText);
  return { content: [{ type: 'text', text }] };
});

server.tool('eval', 'Execute JavaScript on the page', {
  pageId: z.number().describe('Page ID'),
  script: z.string().describe('JavaScript code to execute'),
}, async ({ pageId, script }) => {
  const page = mgr.getPage(pageId);
  const result = await page.evaluate(script);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.tool('get_links', 'Get all links on the page', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = mgr.getPage(pageId);
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim(), href: a.href }))
  );
  return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] };
});

server.tool('get_inputs', 'Get all form inputs on the page', {
  pageId: z.number().describe('Page ID'),
}, async ({ pageId }) => {
  const page = mgr.getPage(pageId);
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

// --- Screenshots & OCR ---

server.tool('screenshot', 'Take a screenshot. IMPORTANT: Prefer snapshot tool first — it is cheaper (no vision tokens). Only use screenshot when you need visual context (layout, images, colors) that snapshot cannot provide. Use ocr=true to extract text locally instead of sending the image.', {
  pageId: z.number().describe('Page ID'),
  path: z.string().optional().describe('File path to save (default: /tmp/screenshot-<timestamp>.png)'),
  fullPage: z.boolean().optional().describe('Capture full page'),
  ocr: z.boolean().optional().describe('Run local OCR and return text instead of image (saves tokens)'),
}, async ({ pageId, path, fullPage, ocr }) => {
  const page = mgr.getPage(pageId);
  const filePath = path || `/tmp/screenshot-${Date.now()}.png`;
  await page.screenshot({ path: filePath, fullPage: fullPage || false });
  if (ocr) {
    const text = await localOCR(filePath);
    return {
      content: [
        { type: 'text', text: `Screenshot saved to ${filePath}\n\n--- OCR Text (local Vision) ---\n${text}` },
      ],
    };
  }
  const base64 = fs.readFileSync(filePath).toString('base64');
  return {
    content: [
      { type: 'text', text: `Screenshot saved to ${filePath}` },
      { type: 'image', data: base64, mimeType: 'image/png' },
    ],
  };
});

server.tool('ocr', 'Extract text from an image file using local Apple Vision OCR (no tokens sent to cloud)', {
  imagePath: z.string().describe('Absolute path to the image file'),
}, async ({ imagePath }) => {
  const text = await localOCR(imagePath);
  return { content: [{ type: 'text', text: text || '(no text detected)' }] };
});

// --- Batch ---

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
  const actionDelay = delayBetween ?? CONFIG.ACTION_DELAY;
  const page = mgr.getPage(pageId);
  const results = [];

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    try {
      switch (a.action) {
        case 'click':
          if (a.ref) {
            const el = await mgr.resolveRef(page, pageId, a.ref);
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
            const el = await mgr.resolveRef(page, pageId, a.ref);
            if (a.clear) await mgr.clearField(page, el);
            await el.type(a.text || '', { delay: a.delay || CONFIG.DEFAULT_TYPING_DELAY });
            results.push(`${i + 1}. Typed into ref ${a.ref}`);
          } else if (a.selector) {
            if (a.clear) await mgr.clearField(page, a.selector);
            await page.type(a.selector, a.text || '', { delay: a.delay || CONFIG.DEFAULT_TYPING_DELAY });
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
          await page.evaluate((sx, sy) => window.scrollBy(sx, sy), a.x || 0, a.y || CONFIG.DEFAULT_SCROLL_Y);
          results.push(`${i + 1}. Scrolled`);
          break;
        case 'wait_for':
          if (a.selector) {
            await page.waitForSelector(a.selector, { timeout: a.delay || CONFIG.WAIT_TIMEOUT, visible: true });
            results.push(`${i + 1}. Found ${a.selector}`);
          }
          break;
        case 'navigate':
          if (a.text) {
            await page.goto(a.text, { waitUntil: 'networkidle2', timeout: CONFIG.NAVIGATION_TIMEOUT });
            results.push(`${i + 1}. Navigated to ${a.text}`);
          }
          break;
      }
      if (i < actions.length - 1) {
        await new Promise(r => setTimeout(r, actionDelay));
      }
    } catch (err) {
      results.push(`${i + 1}. ERROR (${a.action}): ${err.message}`);
      break;
    }
  }

  return { content: [{ type: 'text', text: results.join('\n') }] };
});

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Chrome Local MCP server running on stdio');
}

main().catch(console.error);
