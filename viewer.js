import * as pdfjs from './vendor/pdf.mjs';
import { buildBlocks, buildLexicon } from './src/segment.js';
import { translateBlocks, clearPageCache } from './src/translate.js';
import { getCfg, setCfg } from './src/config.js';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';

const $ = (id) => document.getElementById(id);
const el = {
  docTitle: $('docTitle'),
  status: $('status'),
  banner: $('banner'),
  left: $('left'),
  right: $('right'),
  pages: $('pages'),
  flow: $('flow'),
  overlay: $('overlay'),
  ovTitle: $('ovTitle'),
  ovDesc: $('ovDesc'),
  pickBtn: $('pickBtn'),
  fileInput: $('fileInput'),
  retryBtn: $('retryBtn'),
  modeBtn: $('modeBtn'),
  optBtn: $('optBtn'),
};

const ANCHOR_LINE = 56; // 右栏参照线：内容顶端往下 56px，即眼睛通常落的位置
const AUTO_PAGES = 5;
const AUTO_CHAR_LIMIT = 60000; // 约 5 页单栏正文的量级，超了就等用户点头

const state = {
  cfg: null,
  doc: null,
  pages: [], // { num, blocks, section, canvas, els: Map<id, {zh, wrap}>, controller }
  current: 0, // 当前视口页索引
  followLeft: true, // 左栏是否跟随右栏（用户手动滚左栏后暂停）
  queue: Promise.resolve(),
  stats: { total: 0, done: 0, failed: 0 },
};

/* --------------------------------- 启动 --------------------------------- */

init();

async function init() {
  state.cfg = await getCfg();
  applyMode(state.cfg.mode);
  bindUI();

  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) await loadUrl(src);
  else if (params.get('reason') === 'blob') {
    showOverlay(
      '这个页面把 PDF 渲染在页面内部了',
      '它没有可单独取出的 PDF 地址（浏览器内存里的 blob）。\n可以在页面里点下载，再把文件拖进这个窗口。'
    );
  } else {
    showOverlay('把 PDF 拖进来', '从浏览器里点扩展图标可以翻译当前页面的 PDF；也可以把 PDF 文件拖进这个窗口。');
  }

  if (!state.cfg.apiKey) {
    showBanner('还没有配置 API Key，翻译不会开始。点右上角「设置」填入 DeepSeek（或任意 OpenAI 兼容）接口。');
  }
}

function bindUI() {
  el.pickBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files?.[0];
    if (f) loadFile(f);
  });
  el.modeBtn.addEventListener('click', () => {
    const next = document.body.classList.contains('single') ? 'split' : 'single';
    applyMode(next);
    setCfg({ mode: next });
  });
  el.retryBtn.addEventListener('click', () => {
    const page = state.pages[state.current];
    if (page) enqueue(() => translatePage(page, { reset: true }));
  });
  el.optBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) loadFile(f);
    else showOverlay('只支持 PDF', '拖进来的文件看起来不是 PDF。');
  });

  el.right.addEventListener('scroll', scheduleSync, { passive: true });
  // 用户主动滚右栏 → 左栏重新交给跟随；用户滚左栏 → 退出跟随，免得抢他的滚动条
  for (const ev of ['wheel', 'pointerdown', 'touchstart']) {
    el.right.addEventListener(ev, () => {
      state.followLeft = true;
      scheduleSync();
    }, { passive: true });
    el.left.addEventListener(ev, () => {
      state.followLeft = false;
    }, { passive: true });
  }
  // 译文随时落地会改变段落高度：高度一变就重新对一次
  new ResizeObserver(() => scheduleSync()).observe(el.flow);
}

function applyMode(mode) {
  const single = mode === 'single';
  document.body.classList.toggle('single', single);
  el.modeBtn.textContent = single ? '双栏' : '单栏';
}

/* -------------------------------- 载入 PDF -------------------------------- */

async function loadUrl(src) {
  showOverlay('正在载入 PDF…', src);
  let buf;
  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = await res.arrayBuffer();
  } catch (e) {
    showOverlay(
      '无法读取这个 PDF',
      `${e.message}\n\n可能原因：需要登录、链接是 HTML 页面、或本地 file:// 未授权。\n可以把这个 PDF 直接拖进窗口。`
    );
    return;
  }
  const name = decodeURIComponent(src.split('/').pop().split('?')[0] || 'PDF');
  await loadBytes(buf, name);
}

async function loadFile(file) {
  showOverlay('正在载入 PDF…', file.name);
  await loadBytes(await file.arrayBuffer(), file.name);
}

async function loadBytes(buf, name) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
  if (head !== '%PDF-') {
    showOverlay('这不是 PDF', '文件头不是 %PDF-，可能是一个网页或损坏的文件。');
    return;
  }
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: './vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './vendor/standard_fonts/',
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    showOverlay('PDF 解析失败', e.message);
    return;
  }

  // 支持拖入第二个文件：清空上一个文档的全部状态
  for (const p of state.pages) p.controller?.abort();
  state.doc?.destroy?.();
  state.doc = doc;
  state.pages = [];
  state.current = 0;
  state.stats = { total: 0, done: 0, failed: 0 };
  state.queue = Promise.resolve();
  el.pages.replaceChildren();
  el.flow.replaceChildren();
  el.status.textContent = '';
  el.status.classList.remove('err');
  hideOverlay();

  const meta = await doc.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim() || name;
  el.docTitle.textContent = title;
  el.docTitle.title = title;
  document.title = title;

  // 先拿到所有页的文字层：跨页词表用于判断行尾连字符
  const raw = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    raw.push({
      num: n,
      page,
      vp: page.getViewport({ scale: 1 }),
      tc: await page.getTextContent(),
    });
  }
  const lexicon = buildLexicon(raw.map((r) => r.tc));

  // 骨架 + 段落块
  const frag = document.createDocumentFragment();
  for (const r of raw) {
    const blocks = buildBlocks(r.tc, r.vp.width, { pageIndex: r.num - 1, lexicon });
    const page = makePage(r, blocks);
    state.pages.push(page);
    frag.appendChild(page.section);
    state.stats.total += blocks.length;
  }
  el.flow.appendChild(frag);

  renderAllPages();
  updateStatus();

  if (!state.cfg.apiKey) {
    for (const p of state.pages) markWaiting(p);
    return;
  }
  // 别让用户拖进一本 300 页的书就静默烧掉几十万 token
  const totalChars = state.pages.reduce((s, p) => s + p.blocks.reduce((a, b) => a + b.text.length, 0), 0);
  if (totalChars > AUTO_CHAR_LIMIT) {
    const head = state.pages.slice(0, AUTO_PAGES);
    for (const p of head) enqueue(() => translatePage(p));
    showBanner(`这份文档约 ${Math.round(totalChars / 1000)}k 字符，默认只翻前 ${AUTO_PAGES} 页。`, {
      label: '翻译全文',
      onClick: () => {
        hideBanner();
        for (const p of state.pages.slice(AUTO_PAGES)) enqueue(() => translatePage(p));
      },
    });
    return;
  }
  for (const p of state.pages) enqueue(() => translatePage(p));
}

function makePage(r, blocks) {
  const page = {
    num: r.num,
    pdfPage: r.page,
    vp: r.vp,
    blocks,
    els: new Map(),
    canvas: null,
    controller: null,
  };

  const section = document.createElement('section');
  section.className = 'page-sec';
  section.dataset.page = String(r.num);

  const head = document.createElement('div');
  head.className = 'page-head';
  head.textContent = `第 ${r.num} 页`;
  section.appendChild(head);

  for (const b of blocks) {
    const wrap = document.createElement('div');
    wrap.className = `blk ${b.type}`;
    const en = document.createElement('p');
    en.className = 'en';
    en.textContent = b.text;
    const zh = document.createElement('p');
    zh.className = 'zh pending';
    wrap.append(en, zh);
    page.els.set(b.id, { zh, wrap });
    section.appendChild(wrap);
  }
  page.section = section;
  return page;
}

/* ------------------------------- 左栏渲染 -------------------------------- */

function renderAllPages() {
  // 按真实栏宽渲染（dpr 另算），否则宽屏上会把 560px 的位图放大而发虚
  const width = Math.max(320, Math.min(1400, el.left.clientWidth - 24));
  for (const page of state.pages) {
    const vpW = page.vp.width;
    const scale = width / vpW;
    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vpW * scale * dpr);
    canvas.height = Math.floor(page.vp.height * scale * dpr);
    canvas.style.width = '100%';
    canvas.style.aspectRatio = `${vpW} / ${page.vp.height}`;
    page.canvas = canvas;
    page.scale = scale;
    page.dpr = dpr;
    el.pages.appendChild(canvas);
    lazyRender.observe(canvas);
  }
}

// 只渲染进入视口附近的页：100 页的论文也不会一次性爆内存
const lazyRender = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      lazyRender.unobserve(entry.target);
      const page = state.pages.find((p) => p.canvas === entry.target);
      if (page) drawPage(page);
    }
  },
  { rootMargin: '800px 0px' }
);

async function drawPage(page) {
  const vp = page.pdfPage.getViewport({ scale: page.scale });
  const ctx = page.canvas.getContext('2d', { alpha: false });
  try {
    await page.pdfPage.render({
      canvasContext: ctx,
      viewport: vp,
      transform: page.dpr !== 1 ? [page.dpr, 0, 0, page.dpr, 0, 0] : null,
    }).promise;
  } catch (e) {
    console.warn('页面渲染失败', page.num, e);
  }
}

/* ------------------------------- 翻译调度 -------------------------------- */

function enqueue(task) {
  state.queue = state.queue.then(task).catch((e) => {
    console.error(e);
    showError(e.message || String(e));
  });
  return state.queue;
}

async function translatePage(page, { reset = false } = {}) {
  if (reset) {
    await clearPageCache(page.blocks, state.cfg.model);
    // 清空重译也会让版面坍缩，同样要钉住阅读位置
    withStableAnchor(() => {
      for (const { zh } of page.els.values()) {
        zh.className = 'zh pending';
        zh.textContent = '';
      }
    });
  }
  page.controller?.abort();
  page.controller = new AbortController();

  const before = countDone(page);
  try {
    await translateBlocks(page.blocks, state.cfg, {
      signal: page.controller.signal,
      onResult: (b, zh, meta) => setZh(page, b, zh, meta),
      onError: (e, b) => {
        if (b) setFail(page, b, e.message);
        else showError(e.message);
      },
    });
  } finally {
    state.stats.done += countDone(page) - before;
    updateStatus();
  }
}

function setZh(page, block, zh, meta) {
  const node = page.els.get(block.id);
  if (!node) return;
  withStableAnchor(() => {
    node.zh.textContent = zh;
    node.zh.className = 'zh' + (meta?.cached ? ' cached' : '');
  });
}

/**
 * 译文落地会改变段落高度，正在读的那一行会往下跳。
 * 做法：改动前记住锚点段落的视口位置，改动后把位移补回去。
 * 读 rect 会强制同步布局，但只在 DOM 变更前后各一次，代价可接受。
 */
function withStableAnchor(mutate) {
  const anchor = currentAnchorBlock();
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  mutate();
  if (!anchor) return;
  const delta = anchor.getBoundingClientRect().top - before;
  if (Math.abs(delta) > 0.5) el.right.scrollTop += delta;
}

/** 右栏参照线下方第一个段落：读屏时眼睛真正落在的地方 */
function currentAnchorBlock() {
  const section = state.pages[state.current]?.section;
  if (!section) return null;
  const refY = el.right.getBoundingClientRect().top + ANCHOR_LINE;
  for (const b of section.querySelectorAll('.blk')) {
    if (b.getBoundingClientRect().bottom > refY) return b;
  }
  return null;
}

function setFail(page, block, msg) {
  const node = page.els.get(block.id);
  if (!node) return;
  node.zh.textContent = `翻译失败：${msg}`;
  node.zh.className = 'zh fail';
  state.stats.failed++;
  updateStatus();
}

function markWaiting(page) {
  for (const { zh } of page.els.values()) {
    zh.className = 'zh waiting';
    zh.textContent = '（未配置 API Key，暂不翻译）';
  }
}

function countDone(page) {
  let n = 0;
  for (const { zh } of page.els.values()) if (zh.textContent && !zh.classList.contains('pending')) n++;
  return n;
}

/* -------------------------------- 状态栏 --------------------------------- */

function updateStatus() {
  if (!el.status.classList.contains('err')) {
    el.status.textContent = state.stats.total
      ? `已译 ${state.stats.done}/${state.stats.total} 段${state.stats.failed ? ` · 失败 ${state.stats.failed}` : ''}`
      : '';
  }
}

function showError(msg) {
  el.status.textContent = msg.slice(0, 120);
  el.status.classList.add('err');
  clearTimeout(showError.t);
  showError.t = setTimeout(() => {
    el.status.classList.remove('err');
    updateStatus();
  }, 12000);
}

function showBanner(text, action = null) {
  el.banner.replaceChildren(document.createTextNode(text));
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.marginLeft = '10px';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.banner.appendChild(btn);
  }
  el.banner.classList.remove('hidden');
}

function hideBanner() {
  el.banner.classList.add('hidden');
}

function showOverlay(title, desc) {
  el.ovTitle.textContent = title;
  el.ovDesc.textContent = desc;
  el.overlay.classList.remove('hidden');
}

function hideOverlay() {
  el.overlay.classList.add('hidden');
}

/* ------------------------------- 滚动联动 -------------------------------- */

let syncRaf = 0;

function scheduleSync() {
  if (syncRaf) return;
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0;
    syncLeft();
  });
}

/**
 * 左栏跟随右栏：按「当前页 + 页内进度」连续映射，而不是只在换页时对齐一次。
 * 用相对位移（canvas 当前视口位置 vs 期望位置）而不是绝对 offsetTop ——
 * getBoundingClientRect() 是视口坐标，直接拿来赋 scrollTop 本来就是错的。
 */
function syncLeft() {
  if (!state.pages.length) return;
  const pages = state.pages;
  const refY = el.right.getBoundingClientRect().top + ANCHOR_LINE;

  // 取「底边越过参照线」的第一页 —— 也就是参照线真正落在其中的那一页。
  // 不能按「顶部在线上方」来取：段落长短差距大时，上一页可能整个已经翻过去了。
  let idx = pages.length - 1;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].section.getBoundingClientRect().bottom > refY) {
      idx = i;
      break;
    }
  }
  state.current = idx; // 「重译本页」和锚点都以它为准，与是否跟随无关
  if (document.body.classList.contains('single') || !state.followLeft) return;

  const page = pages[idx];
  const rect = page.section.getBoundingClientRect();
  const progress = Math.min(1, Math.max(0, (refY - rect.top) / Math.max(1, rect.height)));

  const canvasRect = page.canvas.getBoundingClientRect();
  const desiredTop = el.left.getBoundingClientRect().top + ANCHOR_LINE - progress * canvasRect.height;
  const delta = canvasRect.top - desiredTop;
  if (Math.abs(delta) > 2) el.left.scrollTop += delta;
}
