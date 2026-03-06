const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

let browser = null;
let pages = {}; // pageId -> page instance
let pageCounter = 0;

// Launch browser
async function launchBrowser(headless = false) {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    defaultViewport: null,
    args: ['--window-size=1440,900', '--no-sandbox'],
  });
  pages = {};
  pageCounter = 0;
  const [defaultPage] = await browser.pages();
  const id = ++pageCounter;
  pages[id] = defaultPage;
  return id;
}

// Get or throw page
function getPage(pageId) {
  const page = pages[pageId];
  if (!page) throw new Error(`Page ${pageId} not found. Available: ${Object.keys(pages).join(', ')}`);
  return page;
}

// --- Routes ---

// Launch browser
app.post('/launch', async (req, res) => {
  try {
    const { headless } = req.body || {};
    const pageId = await launchBrowser(headless);
    res.json({ ok: true, pageId, message: 'Browser launched' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Close browser
app.post('/close', async (req, res) => {
  try {
    if (browser) { await browser.close(); browser = null; pages = {}; }
    res.json({ ok: true, message: 'Browser closed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create new page/tab
app.post('/page/new', async (req, res) => {
  try {
    if (!browser) return res.status(400).json({ ok: false, error: 'Browser not launched' });
    const page = await browser.newPage();
    const id = ++pageCounter;
    pages[id] = page;
    res.json({ ok: true, pageId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// List pages
app.get('/pages', async (req, res) => {
  try {
    const list = [];
    for (const [id, page] of Object.entries(pages)) {
      list.push({ pageId: Number(id), url: page.url(), title: await page.title() });
    }
    res.json({ ok: true, pages: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Navigate
app.post('/navigate', async (req, res) => {
  try {
    const { pageId, url, waitUntil } = req.body;
    const page = getPage(pageId);
    await page.goto(url, { waitUntil: waitUntil || 'networkidle2', timeout: 30000 });
    res.json({ ok: true, url: page.url(), title: await page.title() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Click
app.post('/click', async (req, res) => {
  try {
    const { pageId, selector, text, x, y } = req.body;
    const page = getPage(pageId);
    if (x !== undefined && y !== undefined) {
      await page.mouse.click(x, y);
    } else if (text) {
      // Click element containing text
      const el = await page.evaluateHandle((t) => {
        const elements = [...document.querySelectorAll('*')];
        return elements.find(e => e.textContent.trim() === t && e.offsetParent !== null);
      }, text);
      if (!el) throw new Error(`No element with text "${text}" found`);
      await el.asElement().click();
    } else {
      await page.click(selector);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Type
app.post('/type', async (req, res) => {
  try {
    const { pageId, selector, text, delay, clear } = req.body;
    const page = getPage(pageId);
    if (clear) {
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
    }
    await page.type(selector, text, { delay: delay || 50 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Press key
app.post('/key', async (req, res) => {
  try {
    const { pageId, key } = req.body;
    const page = getPage(pageId);
    await page.keyboard.press(key);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Screenshot
app.post('/screenshot', async (req, res) => {
  try {
    const { pageId, path, fullPage } = req.body;
    const page = getPage(pageId);
    const filePath = path || `/tmp/screenshot-${Date.now()}.png`;
    await page.screenshot({ path: filePath, fullPage: fullPage || false });
    res.json({ ok: true, path: filePath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get page text content
app.post('/text', async (req, res) => {
  try {
    const { pageId, selector } = req.body;
    const page = getPage(pageId);
    let text;
    if (selector) {
      text = await page.$eval(selector, el => el.textContent);
    } else {
      text = await page.evaluate(() => document.body.innerText);
    }
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get page HTML
app.post('/html', async (req, res) => {
  try {
    const { pageId, selector } = req.body;
    const page = getPage(pageId);
    let html;
    if (selector) {
      html = await page.$eval(selector, el => el.outerHTML);
    } else {
      html = await page.content();
    }
    res.json({ ok: true, html });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Execute JavaScript on page
app.post('/eval', async (req, res) => {
  try {
    const { pageId, script } = req.body;
    const page = getPage(pageId);
    const result = await page.evaluate(script);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Wait for selector
app.post('/wait', async (req, res) => {
  try {
    const { pageId, selector, timeout, visible } = req.body;
    const page = getPage(pageId);
    await page.waitForSelector(selector, {
      timeout: timeout || 10000,
      visible: visible !== false,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Wait for navigation
app.post('/wait-navigation', async (req, res) => {
  try {
    const { pageId, timeout } = req.body;
    const page = getPage(pageId);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: timeout || 30000 });
    res.json({ ok: true, url: page.url(), title: await page.title() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Select dropdown
app.post('/select', async (req, res) => {
  try {
    const { pageId, selector, value } = req.body;
    const page = getPage(pageId);
    await page.select(selector, value);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Scroll
app.post('/scroll', async (req, res) => {
  try {
    const { pageId, x, y } = req.body;
    const page = getPage(pageId);
    await page.evaluate((sx, sy) => window.scrollBy(sx, sy), x || 0, y || 500);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get all links on page
app.post('/links', async (req, res) => {
  try {
    const { pageId } = req.body;
    const page = getPage(pageId);
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim(), href: a.href }))
    );
    res.json({ ok: true, links });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get form inputs
app.post('/inputs', async (req, res) => {
  try {
    const { pageId } = req.body;
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
    res.json({ ok: true, inputs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, browserRunning: !!browser, pages: Object.keys(pages).length });
});

const PORT = process.env.PORT || 3033;
app.listen(PORT, () => {
  console.log(`Puppeteer server running on http://localhost:${PORT}`);
  console.log('POST /launch to start browser');
});
