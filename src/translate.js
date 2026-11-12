// LLM 翻译客户端：OpenAI 兼容协议 + 段落级缓存 + 分批 + 降级重试。
// 只在扩展页面里跑（有 chrome.storage 时自动启用持久缓存；Node 里退化成内存缓存）。

// 提示词版本：改动提示词必须递增，缓存键包含它，否则旧译文会被继续复用。
export const PROMPT_VERSION = 2;

export const SYSTEM_PROMPT = [
  'You are a professional translator. The source text may be in English, German, French or any other language;',
  'always translate it into natural, accurate Simplified Chinese. Never reply in the source language.',
  'Rules:',
  '1) Translate every paragraph completely and faithfully. Do not explain, annotate, summarise, add or omit anything.',
  '2) Keep one output per input paragraph, in the same order. Never merge or split paragraphs.',
  '3) Keep unchanged: personal names, institution names, place names, URLs, emails, citation strings, numbers,',
  '   dates, and administrative codes or abbreviations (e.g. EG 13 TV-L, Kenn-Nr. 376/2026, w/m/d, fMRI, LLM, PhD, AI).',
  '4) Use precise and consistent terminology; for academic job ads and research texts use standard Chinese academic wording.',
  '5) If a paragraph is a heading or a label, translate it as a short heading, without a trailing period.',
  '6) If a paragraph consists mainly of numbers, symbols or a formula, return it nearly unchanged.',
  'Output format: a JSON object {"t":[{"i":<index>,"zh":"<translation>"}]} with exactly one element per input paragraph, indices matching the input.',
].join('\n');

const SYSTEM_PLAIN = [
  'You are a professional translator. The text may be in any language; translate it into Simplified Chinese.',
  'Keep names, URLs, numbers and Latin abbreviations unchanged.',
  'Output only the translation, no explanation, no quotes.',
].join(' ');

export class FatalApiError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------- 缓存 ---------------------------------- */

const memCache = new Map();
const store = globalThis.chrome?.storage?.local ?? null;

async function hashKey(model, text) {
  const raw = `${model}|${PROMPT_VERSION}|${text}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return 'zh:' + [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  if (!store) return null;
  const hit = await store.get(key);
  const val = hit?.[key];
  if (typeof val === 'string' && val) {
    memCache.set(key, val);
    return val;
  }
  return null;
}

async function cacheSet(key, val) {
  memCache.set(key, val);
  if (!store) return;
  try {
    await store.set({ [key]: val });
  } catch {
    /* 配额满时忽略：缓存是优化，不是必需品 */
  }
}

/* -------------------------------- 对外接口 -------------------------------- */

/**
 * 翻译一组段落块。缓存命中先回调，未命中的分批请求。
 * @param {Array<{id:string,text:string}>} blocks
 * @param {{model:string, baseUrl:string, apiKey:string}} cfg
 * @param {{onResult?:Function, onError?:Function, signal?:AbortSignal, concurrency?:number, useCache?:boolean}} [handlers]
 */
export async function translateBlocks(blocks, cfg, handlers = {}) {
  const { onResult = () => {}, onError = () => {}, signal, concurrency = 3, useCache = true } = handlers;
  const alive = () => !signal?.aborted;
  const stats = { total: blocks.length, done: 0, cached: 0, failed: 0 };

  const keys = await Promise.all(blocks.map((b) => hashKey(cfg.model, b.text)));
  const pending = [];
  for (let i = 0; i < blocks.length; i++) {
    const hit = useCache ? await cacheGet(keys[i]) : null;
    if (hit) {
      stats.done++;
      stats.cached++;
      onResult(blocks[i], hit, { cached: true });
    } else {
      pending.push({ block: blocks[i], key: keys[i] });
    }
  }
  if (!pending.length || !alive()) return stats;

  let fatal = null;
  const batches = makeBatches(pending);

  await runPool(batches, concurrency, async (batch) => {
    if (!alive() || fatal) return;
    let missing = batch;
    try {
      const map = await requestBatch(batch.map((p) => p.block.text), cfg, signal);
      missing = [];
      for (let i = 0; i < batch.length; i++) {
        const zh = map.get(i);
        if (!zh) {
          missing.push(batch[i]);
          continue;
        }
        stats.done++;
        onResult(batch[i].block, zh, { cached: false });
        cacheSet(batch[i].key, zh);
      }
    } catch (e) {
      if (!alive()) return;
      if (e instanceof FatalApiError) {
        fatal = e;
        onError(e, null);
        return;
      }
    }
    // 整批失败或个别段落缺失 → 逐段纯文本降级（JSON 协议在长段落上最容易被截断）
    for (const p of missing) {
      if (!alive() || fatal) return;
      try {
        const zh = await requestOne(p.block.text, cfg, signal);
        stats.done++;
        onResult(p.block, zh, { cached: false });
        cacheSet(p.key, zh);
      } catch (e2) {
        stats.failed++;
        if (e2 instanceof FatalApiError) {
          fatal = e2;
          onError(e2, p.block);
          return;
        }
        onError(e2, p.block);
      }
    }
  });

  if (fatal) throw fatal;
  return stats;
}

/* --------------------------------- 请求层 --------------------------------- */

export function chatUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions';
}

async function postChat(cfg, body, signal) {
  const url = chatUrl(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (res.ok) {
        const json = await res.json();
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回为空');
        return content;
      }
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 401 || res.status === 403) {
        throw new FatalApiError(`API Key 无效或无权访问（HTTP ${res.status}）`);
      }
      if (res.status === 400 || res.status === 422) {
        const e = new Error(`请求被拒绝（HTTP ${res.status}）：${detail}`);
        e.status = res.status;
        throw e;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw new Error(`HTTP ${res.status}：${detail}`);
    } catch (e) {
      if (e instanceof FatalApiError || e?.status === 400 || e?.status === 422 || e?.name === 'AbortError') throw e;
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`请求失败（已重试 3 次）：${lastErr?.message || '未知错误'}`);
}

async function requestBatch(texts, cfg, signal) {
  const body = {
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ t: texts.map((t, i) => ({ i, text: t })) }) },
    ],
    response_format: { type: 'json_object' },
  };
  let raw;
  try {
    raw = await postChat(cfg, body, signal);
  } catch (e) {
    if (e?.status !== 400 && e?.status !== 422) throw e;
    // 部分兼容端点不支持 response_format，去掉重试
    delete body.response_format;
    raw = await postChat(cfg, body, signal);
  }
  const map = parseTranslations(raw);
  for (const i of [...map.keys()]) if (i < 0 || i >= texts.length) map.delete(i);
  if (!map.size) throw new Error(`模型返回无法解析：${raw.slice(0, 120)}`);
  return map;
}

async function requestOne(text, cfg, signal) {
  const body = {
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PLAIN },
      { role: 'user', content: text },
    ],
  };
  const raw = await postChat(cfg, body, signal);
  return raw.trim().replace(/^["'「]|["'」]$/g, '').trim();
}

/* --------------------------------- 解析层 --------------------------------- */

/** 宽容解析模型输出：容忍 ```json 围栏、前后废话、数组/对象两种形态。 */
export function parseTranslations(raw) {
  const map = new Map();
  const text = String(raw || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const tryJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let data = tryJson(text);
  if (data === undefined) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) data = tryJson(text.slice(a, b + 1));
  }
  if (data === undefined) {
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a >= 0 && b > a) data = tryJson(text.slice(a, b + 1));
  }

  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.t)
      ? data.t
      : Array.isArray(data?.translations)
        ? data.translations
        : data && typeof data === 'object' && ('zh' in data || 'translation' in data)
          ? [data]
          : [];

  arr.forEach((o, pos) => {
    if (!o || typeof o !== 'object') return;
    const raw = o.i ?? o.index ?? o.id;
    // 模型偶尔省略序号：用数组位置兜底，避免整批丢弃
    const idx = raw === undefined || raw === null || raw === '' ? pos : Number(raw);
    const zh = o.zh ?? o.translation ?? o.text ?? o.zh_cn;
    if (Number.isInteger(idx) && typeof zh === 'string' && zh.trim()) map.set(idx, zh.trim());
  });
  return map;
}

/* --------------------------------- 工具层 --------------------------------- */

function makeBatches(pending, maxChars = 1500, maxItems = 8) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const p of pending) {
    const n = p.block.text.length;
    if (cur.length && (len + n > maxChars || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function runPool(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export async function clearPageCache(blocks, model) {
  const keys = await Promise.all(blocks.map((b) => hashKey(model, b.text)));
  keys.forEach((k) => memCache.delete(k));
  if (store) await store.remove(keys);
}