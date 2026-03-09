const express = require('express');
const { BrowserManager, CONFIG } = require('./browser-manager');

const mgr = new BrowserManager();
const app = express();
app.use(express.json({ limit: '10mb' }));

// Helper: wrap async route handlers with error handling
function route(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  };
}

// --- Browser lifecycle ---

app.post('/launch', route(async (req, res) => {
  const { headless } = req.body || {};
  const pageId = await mgr.launch(headless);
  res.json({ ok: true, pageId, message: 'Browser launched' });
}));

app.post('/close', route(async (req, res) => {
  await mgr.close();
  res.json({ ok: true, message: 'Browser closed' });
}));

app.post('/page/new', route(async (req, res) => {
  const pageId = await mgr.newTab();
  res.json({ ok: true, pageId });
}));

app.get('/pages', route(async (req, res) => {
  const list = await mgr.listPages();
  res.json({ ok: true, pages: list });
}));

// --- Navigation ---

app.post('/navigate', route(async (req, res) => {
  const { pageId, url, waitUntil } = req.body;
  const page = mgr.getPage(pageId);
  await page.goto(url, { waitUntil: waitUntil || 'networkidle2', timeout: CONFIG.NAVIGATION_TIMEOUT });
  res.json({ ok: true, url: page.url(), title: await page.title() });
}));

// --- Interaction ---

app.post('/click', route(async (req, res) => {
  const { pageId, selector, text, x, y } = req.body;
  const page = mgr.getPage(pageId);
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
  } else {
    await page.click(selector);
  }
  res.json({ ok: true });
}));

app.post('/type', route(async (req, res) => {
  const { pageId, selector, text, delay, clear } = req.body;
  const page = mgr.getPage(pageId);
  if (clear) await mgr.clearField(page, selector);
  await page.type(selector, text, { delay: delay || CONFIG.DEFAULT_TYPING_DELAY });
  res.json({ ok: true });
}));

app.post('/key', route(async (req, res) => {
  const { pageId, key } = req.body;
  const page = mgr.getPage(pageId);
  await page.keyboard.press(key);
  res.json({ ok: true });
}));

// --- Screenshots ---

app.post('/screenshot', route(async (req, res) => {
  const { pageId, path, fullPage } = req.body;
  const page = mgr.getPage(pageId);
  const filePath = path || `/tmp/screenshot-${Date.now()}.png`;
  await page.screenshot({ path: filePath, fullPage: fullPage || false });
  res.json({ ok: true, path: filePath });
}));

// --- Inspection ---

app.post('/text', route(async (req, res) => {
  const { pageId, selector } = req.body;
  const page = mgr.getPage(pageId);
  const text = selector
    ? await page.$eval(selector, el => el.textContent)
    : await page.evaluate(() => document.body.innerText);
  res.json({ ok: true, text });
}));

app.post('/html', route(async (req, res) => {
  const { pageId, selector } = req.body;
  const page = mgr.getPage(pageId);
  const html = selector
    ? await page.$eval(selector, el => el.outerHTML)
    : await page.content();
  res.json({ ok: true, html });
}));

app.post('/eval', route(async (req, res) => {
  const { pageId, script } = req.body;
  const page = mgr.getPage(pageId);
  const result = await page.evaluate(script);
  res.json({ ok: true, result });
}));

// --- Waiting ---

app.post('/wait', route(async (req, res) => {
  const { pageId, selector, timeout, visible } = req.body;
  const page = mgr.getPage(pageId);
  await page.waitForSelector(selector, {
    timeout: timeout || CONFIG.WAIT_TIMEOUT,
    visible: visible !== false,
  });
  res.json({ ok: true });
}));

app.post('/wait-navigation', route(async (req, res) => {
  const { pageId, timeout } = req.body;
  const page = mgr.getPage(pageId);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: timeout || CONFIG.NAVIGATION_TIMEOUT });
  res.json({ ok: true, url: page.url(), title: await page.title() });
}));

// --- Form elements ---

app.post('/select', route(async (req, res) => {
  const { pageId, selector, value } = req.body;
  const page = mgr.getPage(pageId);
  await page.select(selector, value);
  res.json({ ok: true });
}));

app.post('/scroll', route(async (req, res) => {
  const { pageId, x, y } = req.body;
  const page = mgr.getPage(pageId);
  await page.evaluate((sx, sy) => window.scrollBy(sx, sy), x || 0, y || CONFIG.DEFAULT_SCROLL_Y);
  res.json({ ok: true });
}));

app.post('/links', route(async (req, res) => {
  const { pageId } = req.body;
  const page = mgr.getPage(pageId);
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim(), href: a.href }))
  );
  res.json({ ok: true, links });
}));

app.post('/inputs', route(async (req, res) => {
  const { pageId } = req.body;
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
  res.json({ ok: true, inputs });
}));

// --- Health ---

app.get('/health', (req, res) => {
  res.json({ ok: true, browserRunning: !!mgr.browser, pages: Object.keys(mgr.pages).length });
});

// --- Start ---

const PORT = process.env.PORT || 3033;
app.listen(PORT, () => {
  console.log(`Puppeteer server running on http://localhost:${PORT}`);
  console.log('POST /launch to start browser');
});
