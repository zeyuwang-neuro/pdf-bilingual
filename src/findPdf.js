// 在页面 DOM 里找「内嵌的 PDF」。
//
// 这个函数会被 chrome.scripting.executeScript 序列化后注入页面执行，
// 因此**不能引用任何外部变量/导入**（序列化只带走函数源码，不带作用域）。
// 保持零依赖、纯 DOM 操作，才能既注入又单测。

export function scanEmbeddedPdf() {
  const out = [];
  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  };
  const push = (url, el, kind) => {
    const href = abs(url);
    if (!href) return;
    let area = 0;
    try {
      const r = el.getBoundingClientRect();
      area = Math.max(0, r.width) * Math.max(0, r.height);
    } catch {
      /* 没有布局信息 */
    }
    out.push({ url: href, area, kind });
  };

  // 整页就是 PDF
  if (document.contentType === 'application/pdf') out.push({ url: location.href, area: 1e9, kind: 'document' });

  // iframe / embed / object：Edge 内嵌 PDF 工具栏就是这几种承载的
  for (const el of document.querySelectorAll('iframe[src], embed[src], object[data]')) {
    const raw = el.getAttribute('src') || el.getAttribute('data') || '';
    if (!raw) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const pdfish =
      /\.pdf($|[?#&])/i.test(raw) ||
      type.includes('pdf') ||
      /pdf/i.test(raw) ||
      /^blob:/i.test(raw);
    if (pdfish) push(raw, el, el.tagName.toLowerCase());
  }

  // 兜底：页面里指向 .pdf 的链接（挑面积最大的那个，通常就是正文里的下载链接）
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/\.pdf($|[?#&])/i.test(href)) push(href, a, 'a');
  }

  out.sort((x, y) => y.area - x.area);
  // 同一 URL 只留一条（面积最大的）
  const seen = new Set();
  return out.filter((o) => (seen.has(o.url) ? false : (seen.add(o.url), true)));
}

/** 从扫描结果里挑出该翻的那个；挑不到返回 null。纯函数，便于单测。 */
export function pickBest(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const usable = candidates.filter((c) => c && typeof c.url === 'string');
  const nonBlob = usable.filter((c) => !/^blob:/i.test(c.url) && !/^data:/i.test(c.url));
  const pool = nonBlob.length ? nonBlob : usable;
  if (!pool.length) return null;
  // 面积最大的优先；面积都为 0（隐藏元素）时取第一个非链接的承载元素
  const best = pool.reduce((a, b) => ((b.area || 0) > (a.area || 0) ? b : a), pool[0]);
  if ((best.area || 0) > 0 || best.kind !== 'a') return best;
  const embedLike = pool.find((c) => c.kind !== 'a');
  return embedLike || best;
}