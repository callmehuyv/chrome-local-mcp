const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// --- Configuration ---
const CONFIG = {
  USER_DATA_DIR: path.join(os.homedir(), '.chrome-local-mcp-profile'),
  WINDOW_SIZE: '1440,900',
  DEFAULT_TYPING_DELAY: 50,
  NAVIGATION_TIMEOUT: 30000,
  WAIT_TIMEOUT: 10000,
  OCR_TIMEOUT: 15000,
  DEFAULT_SCROLL_Y: 500,
  ACTION_DELAY: 100,
  INTERACTABLE_ROLES: [
    'button', 'link', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
    'tab', 'menuitem', 'option', 'treeitem',
  ],
  ROLE_TO_SELECTORS: {
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
  },
};

// --- OCR (macOS only) ---
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
    execFile('python3', ['-c', script, imagePath], { timeout: CONFIG.OCR_TIMEOUT }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`OCR failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

// --- Browser Manager ---
class BrowserManager {
  constructor() {
    this.browser = null;
    this.pages = {};
    this.pageCounter = 0;
    this.pageRefs = {};   // { pageId: { 'e1': { role, name, nodeInfo }, ... } }
    this.refCounter = 0;
  }

  async launch(headless = false) {
    if (this.browser) {
      try { await this.browser.close(); } catch (_) {}
    }
    this.browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      defaultViewport: null,
      userDataDir: CONFIG.USER_DATA_DIR,
      args: [`--window-size=${CONFIG.WINDOW_SIZE}`, '--no-sandbox'],
    });
    this.pages = {};
    this.pageCounter = 0;
    const [defaultPage] = await this.browser.pages();
    const id = ++this.pageCounter;
    this.pages[id] = defaultPage;
    return id;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.pages = {};
    }
  }

  async newTab() {
    if (!this.browser) throw new Error('Browser not launched. Call launch first.');
    const page = await this.browser.newPage();
    const id = ++this.pageCounter;
    this.pages[id] = page;
    return id;
  }

  async listPages() {
    const list = [];
    for (const [id, page] of Object.entries(this.pages)) {
      list.push({ pageId: Number(id), url: page.url(), title: await page.title() });
    }
    return list;
  }

  getPage(pageId) {
    const page = this.pages[pageId];
    if (!page) throw new Error(`Page ${pageId} not found. Available: ${Object.keys(this.pages).join(', ')}`);
    return page;
  }

  // Build YAML-like snapshot from accessibility tree with element refs
  async buildSnapshot(page, pageId) {
    const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
    if (!snapshot) return { text: '(empty page)', refs: {} };

    const refs = {};
    this.refCounter = 0;
    const lines = [];

    const renderNode = (node, indent = 0) => {
      const prefix = '  '.repeat(indent);
      const role = node.role || 'generic';
      const name = node.name || '';

      let refTag = '';
      if (CONFIG.INTERACTABLE_ROLES.includes(role) || node.focused) {
        const ref = 'e' + (++this.refCounter);
        refTag = ` [ref=${ref}]`;
        refs[ref] = { role, name, nodeInfo: node };
      }

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

      let valueStr = '';
      if (node.value !== undefined && node.value !== '') {
        valueStr = `: "${node.value}"`;
      }

      const nameStr = name ? ` "${name}"` : '';
      lines.push(`${prefix}- ${role}${nameStr}${refTag}${stateStr}${valueStr}`);

      if (node.children) {
        for (const child of node.children) {
          renderNode(child, indent + 1);
        }
      }
    };

    renderNode(snapshot);
    return { text: lines.join('\n'), refs };
  }

  // Resolve a ref to a DOM element handle
  async resolveRef(page, pageId, ref) {
    const refMap = this.pageRefs[pageId];
    if (!refMap || !refMap[ref]) throw new Error(`Ref "${ref}" not found. Take a new snapshot first.`);

    const { role, name } = refMap[ref];

    const el = await page.evaluateHandle(({ role, name, roleToSelectors }) => {
      const selectors = roleToSelectors[role] || [`[role="${role}"]`];
      for (const sel of selectors) {
        const elements = [...document.querySelectorAll(sel)];
        for (const el of elements) {
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
    }, { role, name, roleToSelectors: CONFIG.ROLE_TO_SELECTORS });

    const element = el.asElement();
    if (!element) throw new Error(`Could not find element for ref "${ref}" (${role} "${name}"). Page may have changed — take a new snapshot.`);
    return element;
  }

  // Store snapshot refs for a page
  storeRefs(pageId, refs) {
    this.pageRefs[pageId] = refs;
  }

  getRefInfo(pageId, ref) {
    const refMap = this.pageRefs[pageId];
    return refMap && refMap[ref];
  }

  // Clear a field (triple-click + backspace)
  async clearField(page, elementOrSelector) {
    if (typeof elementOrSelector === 'string') {
      await page.click(elementOrSelector, { clickCount: 3 });
    } else {
      await elementOrSelector.click({ clickCount: 3 });
    }
    await page.keyboard.press('Backspace');
  }
}

module.exports = { BrowserManager, CONFIG, localOCR };
