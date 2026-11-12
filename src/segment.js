// 把 pdf.js 的 textContent.items 还原成「段落块」。
// 纯函数、无 DOM、无 chrome API —— 可在 Node 里直接测。
//
// 三步聚类：items → 行段（同基线上按大间隙切开，否则两栏会并成一行）
//           → 栏（沿页中竖缝切）
//           → 段落（按本栏自身的行距中位数切）

const HYPHEN_END = /[-\u2010\u2011]$/;
const HEADING_COLON = /^[A-Z][\p{L}\p{N} &,'’\/()+.-]{0,48}[:：]$/u;
const HEADING_NUMBERED = /^\d+(?:\.\d+)*\.?\s+\p{Lu}/u;

/**
 * 全文档词表：用来判断「行尾连字符」是复合词的一部分（high-resolution）
 * 还是排版断词（inflam- / mation）。单一页面信息不足，需跨页收集。
 */
export function buildLexicon(textContents) {
  const lex = new Set();
  for (const tc of textContents) {
    for (const it of tc?.items || []) {
      for (const raw of String(it?.str || '').split(/\s+/)) {
        const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
        if (w.length > 1) lex.add(w);
      }
    }
  }
  return lex;
}

/**
 * @param {{items: Array}} textContent pdf.js page.getTextContent()
 * @param {number} pageWidth PDF 用户单位下的页宽（viewport(scale:1).width）
 * @param {{pageIndex?: number, lexicon?: Set<string>}} [opts]
 * @returns {Array<{id:string, type:'title'|'heading'|'para', text:string}>}
 */
export function buildBlocks(textContent, pageWidth, opts = {}) {
  const { pageIndex = 0, lexicon = null } = opts;
  const items = (textContent?.items || [])
    .filter((it) => typeof it?.str === 'string' && it.str.trim() !== '' && Number.isFinite(it.transform?.[4]))
    .map((it) => {
      const font = Math.abs(it.transform[3]) || it.height || 10;
      return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, font };
    });
  if (!items.length) return [];

  const segments = buildSegments(items);
  const blocks = [];
  splitColumns(segments, pageWidth).forEach((col, ci) =>
    blocks.push(...columnToBlocks(col, ci, lexicon))
  );

  // 阅读顺序：先左栏再右栏，栏内由上到下（PDF 的 y 轴向上，故降序）
  blocks.sort((a, b) => a.col - b.col || b.y - a.y);

  const bodyFont = weightedMedianFont(blocks);
  for (const b of blocks) {
    const upper =
      b.text.length >= 4 && b.text.length < 90 && b.text === b.text.toUpperCase() && /\p{L}/u.test(b.text);
    if (b.heading) b.type = 'heading';
    else if (upper) b.type = 'heading';
    else if (b.font >= bodyFont * 1.12 && b.text.length < 140) b.type = 'heading';
    else b.type = 'para';
  }
  // 首页首块作标题：多数 PDF 的标题只靠粗体区分（transform 里拿不到字重），
  // 字号与正文相同，因此按位置判定比按字号判定可靠。
  const first = blocks[0];
  if (first && pageIndex === 0 && first.col === 0 && first.type === 'para') first.type = 'title';

  return blocks.map((b, i) => ({ id: `${pageIndex}:${b.col}:${i}`, type: b.type, text: b.text }));
}

/* ------------------------------- 行段聚类 -------------------------------- */

const GAP_SPLIT_FACTOR = 2.5; // 同一基线上横向间隙 > 2.5 字宽 → 属于不同栏

function buildSegments(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const segs = [];
  for (const it of sorted) {
    const last = segs[segs.length - 1];
    const tol = Math.max(2, it.font * 0.4);
    const sameLine = last && Math.abs(last.y - it.y) <= tol;
    // 关键：同一基线上横向隔得很远（两栏）不能并成一行
    const adjacent = sameLine && it.x - last.x2 <= Math.max(3, it.font * GAP_SPLIT_FACTOR) && it.x >= last.x;
    if (adjacent) {
      last.items.push(it);
      last.x2 = Math.max(last.x2, it.x + it.w);
    } else {
      segs.push({ y: it.y, x: it.x, x2: it.x + it.w, items: [it] });
    }
  }
  for (const s of segs) {
    s.items.sort((a, b) => a.x - b.x);
    s.x = s.items[0].x;
    s.x2 = Math.max(...s.items.map((i) => i.x + i.w));
    s.text = joinLine(s.items);
    s.font = median(s.items.map((i) => i.font));
  }
  return segs;
}

/* -------------------------------- 分栏检测 -------------------------------- */

/**
 * 在页面中部竖直方向上找一条「最少行段穿过」的窄带；若穿过比例够低，就是栏缝。
 * 用行段而非 items 计数：公式、图注这类跨栏小块不会掩盖真正的栏缝。
 */
function splitColumns(segments, pageWidth) {
  if (segments.length < 4) return [segments];
  const lo = pageWidth * 0.28;
  const hi = pageWidth * 0.72;
  const bandW = Math.max(3, pageWidth * 0.015);
  let best = null;
  for (let x = lo; x + bandW <= hi; x += 1.5) {
    let crossing = 0;
    for (const s of segments) if (s.x < x + bandW && s.x2 > x + bandW * 0.2) crossing++;
    const frac = crossing / segments.length;
    // 多个位置同样"少穿越"时，取最靠近页心的那个：两栏版式的栏缝就在中间
    const better =
      !best ||
      frac < best.frac - 1e-9 ||
      (Math.abs(frac - best.frac) < 1e-9 && Math.abs(x - pageWidth / 2) < Math.abs(best.x - pageWidth / 2));
    if (better) best = { x, frac };
  }
  if (!best || best.frac > 0.32) return [segments];

  const cut = best.x + bandW / 2;
  const left = segments.filter((s) => (s.x + s.x2) / 2 < cut);
  const right = segments.filter((s) => (s.x + s.x2) / 2 >= cut);
  const min = segments.length * 0.15;
  if (left.length < min || right.length < min) return [segments];
  return [left, right];
}

/* -------------------------------- 段落聚类 -------------------------------- */

function columnToBlocks(segments, col, lexicon) {
  const lines = [...segments].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const ln of lines) {
    const words = ln.text.split(/\s+/).length;
    ln.heading =
      (HEADING_COLON.test(ln.text) && words <= 8) ||
      (HEADING_NUMBERED.test(ln.text) && words <= 12 && ln.text.length < 90);
  }

  // 行距中位数只取本栏相邻行的间距，避免被上下标/公式的小字号带偏
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  const lineGap = median(gaps) || 12;

  const groups = [];
  for (const ln of lines) {
    const g = groups[groups.length - 1];
    const gap = g ? g.prevY - ln.y : Infinity;
    const sameFont = !g || Math.abs(ln.font - g.font) <= g.font * 0.12;
    if (ln.heading || g?.heading) {
      groups.push({ lines: [ln], font: ln.font, prevY: ln.y, heading: ln.heading });
      continue;
    }
    if (g && gap > 0 && gap < lineGap * 1.45 && sameFont) {
      g.lines.push(ln);
      g.prevY = ln.y;
    } else {
      groups.push({ lines: [ln], font: ln.font, prevY: ln.y, heading: false });
    }
  }

  const out = [];
  for (const g of groups) {
    const text = mergeLines(g.lines, lexicon);
    if (text.replace(/[\s\d]/g, '').length < 2) continue; // 纯页码 / 杂点
    out.push({ text, col, y: g.lines[0].y, font: g.font, heading: g.heading });
  }
  return out;
}

/* --------------------------------- 文本拼接 -------------------------------- */

function joinLine(items) {
  let s = items[0].str;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const gap = cur.x - (prev.x + prev.w);
    const space = gap > Math.max(0.6, cur.font * 0.15) && !/\s$/.test(s) && !/^\s/.test(cur.str);
    s += (space ? ' ' : '') + cur.str;
  }
  return s.replace(/\s+/g, ' ').trim();
}

function mergeLines(lines, lexicon) {
  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) out = joinAcross(out, lines[i].text, lexicon);
  return out.replace(/\s+/g, ' ').trim();
}

/** 跨行拼接：行尾连字符时，查词表判断是复合词还是断词 */
function joinAcross(out, next, lexicon) {
  if (!HYPHEN_END.test(out) || !/^[a-z]/.test(next)) return out + ' ' + next;
  const stem = (out.match(/(\S+)$/)?.[0] || '').slice(0, -1);
  const head = next.match(/^[a-z]+/)?.[0] || '';
  if (!stem || !head) return out.replace(HYPHEN_END, '') + next;
  if (lexicon) {
    const hasKeep = lexicon.has(`${stem}-${head}`.toLowerCase());
    const hasDrop = lexicon.has(`${stem}${head}`.toLowerCase());
    if (hasDrop && !hasKeep) return out.replace(HYPHEN_END, '') + next; // inflam-mation → inflammation
    if (hasKeep) return out + next; //                                    high-resolution 保持原样
  }
  return out + next; // 词表未命中：保留连字符（宁可多一个连字符，不要吃掉真复合词）
}

/* ---------------------------------- 统计 ---------------------------------- */

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function weightedMedianFont(blocks) {
  const pairs = blocks.map((b) => [b.font, b.text.length]).sort((x, y) => x[0] - y[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const [f, n] of pairs) {
    acc += n;
    if (acc >= total / 2) return f;
  }
  return pairs.length ? pairs[pairs.length - 1][0] : 10;
}