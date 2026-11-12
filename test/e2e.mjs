// 端到端测试：真 Chromium 加载扩展 → 打开阅读器 → 校验渲染与双语对照。
// 不依赖 playwright：直接用 Node 内置 WebSocket 说 CDP。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { startMockLLM } from './mock-llm.mjs';
import { scanEmbeddedPdf } from '../src/findPdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const CHROME = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- CDP 客户端 ------------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP 连接失败'));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 30000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常');
    return r.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 20000);
  }

  async waitFor(expression, timeout = 20000, label = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(`!!(${expression})`)) return true;
      } catch {
        /* 导航中，重试 */
      }
      await sleep(200);
    }
    throw new Error(`等待超时: ${label}`);
  }
}

/* --------------------------------- 环境 --------------------------------- */

const HOST_HTML = `<!doctype html><meta charset="utf-8"><title>host page</title>
<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;height:100vh}
iframe{width:100%;height:100%;border:0}</style>
<div id="left-side">普通网页内容</div>
<iframe src="/paper.pdf"></iframe>`;

function servePdf(file) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/paper.pdf')) {
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
      res.end(buf);
    } else if (req.url.startsWith('/favicon.ico')) {
      res.writeHead(204).end();
    } else if (req.url.startsWith('/host.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HOST_HTML);
    } else {
      res.writeHead(404).end('nope');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function httpJson(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function launchChrome(debugPort, profileDir) {
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      '--password-store=basic',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 100; i++) {
    try {
      const v = await httpJson(debugPort, '/json/version');
      if (v?.webSocketDebuggerUrl) return proc;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  proc.kill('SIGKILL');
  throw new Error('Chromium 启动超时');
}

/* --------------------------------- 主流程 --------------------------------- */

async function run() {
  const ok = [];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbilingual-profile-'));
  const debugPort = 9333 + Math.floor(Math.random() * 200);
  const pdf = await servePdf(path.join(here, 'fixtures', 'sample.pdf'));
  const llm = await startMockLLM({ fatAfter: 2 }); // 第 3 个请求起返回 8 倍长的译文
  let proc;

  try {
    proc = await launchChrome(debugPort, profileDir);

    // 扩展 id 由「解包目录绝对路径」的 sha256 决定（Chromium 的既定算法）：
    // 不能靠 /json/list 里出现的第一个 chrome-extension:// 猜——那可能是内置组件扩展。
    const extId = crypto
      .createHash('sha256')
      .update(EXT)
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    ok.push(`扩展 id=${extId}`);

    const pages = (await httpJson(debugPort, '/json/list')).filter((t) => t.type === 'page');
    const cdp = await CDP.connect(pages[0].webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // 1) 写入配置（等于用户在设置页填表）
    await cdp.goto(`chrome-extension://${extId}/options.html`);
    await cdp.eval(
      `chrome.storage.local.set({cfg:{baseUrl:${JSON.stringify(llm.url)},apiKey:'sk-test',model:'mock-e2e',mode:'split'}}).then(()=>true)`
    );
    ok.push('设置页可打开、storage 可写');

    // 2) 网页里内嵌 PDF（左边普通网页、右边 Edge PDF 工具栏那种）
    await cdp.goto(`http://127.0.0.1:${pdf.port}/host.html`);
    const found = await cdp.eval(`(${scanEmbeddedPdf.toString()})()`);
    assert.ok(Array.isArray(found) && found.length > 0, '页面里应扫到内嵌 PDF');
    const hit = found.find((c) => c.url.endsWith('/paper.pdf'));
    assert.ok(hit, `应扫到 iframe 的 PDF 地址，实际 ${JSON.stringify(found)}`);
    assert.equal(hit.kind, 'iframe');
    assert.ok(hit.area > 0, '可见 iframe 应有面积');
    ok.push(`内嵌 PDF 扫描：${found.length} 个候选，命中 ${hit.kind}`);

    // 3) 打开阅读器（用扫出来的地址，正是后台会传的那个）
    const target = `chrome-extension://${extId}/viewer.html?src=${encodeURIComponent(hit.url)}`;
    await cdp.goto(target);
    await cdp.waitFor(`document.querySelectorAll('.blk').length >= 14`, 25000, '段落块生成');
    const blockCount = await cdp.eval(`document.querySelectorAll('.blk').length`);
    assert.equal(blockCount, 14, `应有 14 段，实际 ${blockCount}`);
    ok.push(`段落块渲染：${blockCount} 块`);

    // 3) 等翻译完成
    await cdp.waitFor(`[...document.querySelectorAll('.blk .zh')].every(e=>!e.classList.contains('pending'))`, 30000, '译文补齐');
    const zh = await cdp.eval(`[...document.querySelectorAll('.blk .zh')].map(e=>e.textContent)`);
    assert.equal(zh.length, 14);
    const withCjk = zh.filter((t) => /[\u4e00-\u9fff]/.test(t)).length;
    assert.equal(withCjk, 14, `应有中文译文，实际 ${withCjk}/14：${JSON.stringify(zh.slice(0, 3))}`);
    assert.ok(zh[0].startsWith('中译0'), `首段译文异常: ${zh[0]}`);
    ok.push('14 段全部拿到中文译文（走 mock LLM）');

    // 4) 原文英文也展示出来了
    const en = await cdp.eval(`[...document.querySelectorAll('.blk .en')].map(e=>e.textContent)`);
    assert.ok(en[0].includes('high-resolution fMRI'), `英文标题异常: ${en[0]}`);
    assert.ok(en.some((t) => t === 'Project description:'), '英文小标题应在');
    ok.push('英文原文与中文并排显示');

    // 5) 左栏 canvas 真的画出了东西
    const canvasInfo = await cdp.eval(`(() => {
      const cs=[...document.querySelectorAll('#pages canvas')];
      return cs.map(c => {
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let ink=0; for (let i=0;i<d.length;i+=4) if (d[i]<200) ink++;
        return {w:c.width,h:c.height,ink};
      });
    })()`);
    assert.equal(canvasInfo.length, 2, '两页都应生成 canvas');
    assert.ok(canvasInfo.every((c) => c.w > 300 && c.h > 400), `canvas 尺寸异常: ${JSON.stringify(canvasInfo)}`);
    assert.ok(canvasInfo.every((c) => c.ink > 500), `页面没画出内容: ${JSON.stringify(canvasInfo)}`);
    ok.push(`原页渲染：${canvasInfo.map((c) => `${c.w}x${c.h}(${c.ink}px墨)`).join(', ')}`);

    // 6) 缓存与状态栏
    const status = await cdp.eval(`document.getElementById('status').textContent`);
    assert.match(status, /已译 14\/14/, `状态栏异常: ${status}`);
    ok.push(`状态栏：${status}`);

    // 7) 单栏切换
    await cdp.eval(`document.getElementById('modeBtn').click()`);
    const single = await cdp.eval(`document.body.classList.contains('single')`);
    assert.ok(single, '单栏切换失败');
    await cdp.eval(`document.getElementById('modeBtn').click()`);
    ok.push('双栏/单栏切换正常');

    // 8) 滚动联动：滚到第 2 页顶，左栏应把第 2 页对齐到参照线
    await cdp.eval(`(() => {
      const r = document.getElementById('right');
      const sec = document.querySelectorAll('.page-sec')[1];
      r.scrollTop += sec.getBoundingClientRect().top - r.getBoundingClientRect().top - 56;
      return true;
    })()`);
    await sleep(350); // 等一帧 rAF 完成联动
    const align = await cdp.eval(`(() => {
      const leftTop = document.getElementById('left').getBoundingClientRect().top;
      const c2 = document.querySelectorAll('#pages canvas')[1].getBoundingClientRect().top;
      return Math.round(c2 - leftTop);
    })()`);
    const dbg = await cdp.eval(`(() => {
      const left = document.getElementById('left');
      const r = document.getElementById('right');
      const secs = [...document.querySelectorAll('.page-sec')];
      const c = document.querySelectorAll('#pages canvas');
      return {
        refY: Math.round(r.getBoundingClientRect().top + 56),
        sec1Top: Math.round(secs[1].getBoundingClientRect().top),
        sec0Top: Math.round(secs[0].getBoundingClientRect().top),
        sec1H: Math.round(secs[1].getBoundingClientRect().height),
        canvas1Top: Math.round(c[1].getBoundingClientRect().top),
        leftTop: Math.round(left.getBoundingClientRect().top),
        leftScrollTop: Math.round(left.scrollTop),
        leftMax: left.scrollHeight - left.clientHeight,
        paneH: left.clientHeight,
      };
    })()`);
    assert.ok(Math.abs(align - 56) < 12, `左栏第 2 页应对齐参照线 56px，实际 ${align}px | ${JSON.stringify(dbg)}`);
    ok.push(`滚动联动：滚到第 2 页，左栏对齐偏移 ${align}px`);

    // 9) 译文重新落地不得把阅读位置顶飞（锚点保持）
    await cdp.eval(`(() => { document.getElementById('right').scrollTop = 240; return true; })()`);
    await sleep(250);
    const anchor = await cdp.eval(`(() => {
      const refY = document.getElementById('right').getBoundingClientRect().top + 56;
      const blocks = [...document.querySelectorAll('.page-sec')[0].querySelectorAll('.blk')];
      const i = blocks.findIndex((b) => b.getBoundingClientRect().bottom > refY);
      return { i, top: blocks[i].getBoundingClientRect().top };
    })()`);
    const reqBefore = llm.state.requests;
    await cdp.eval(`document.getElementById('retryBtn').click()`);
    await sleep(800);
    await cdp.waitFor(`[...document.querySelectorAll('.blk .zh')].every(e=>!e.classList.contains('pending'))`, 40000, '重译完成');
    assert.ok(llm.state.requests > reqBefore, '重译本页应真的发出了新请求');
    const drift = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.page-sec')[0].querySelectorAll('.blk')][${anchor.i}];
      return Math.round(b.getBoundingClientRect().top - ${anchor.top});
    })()`);
    const heightGrew = await cdp.eval(`Math.round(document.getElementById('flow').scrollHeight)`);
    assert.ok(Math.abs(drift) < 12, `重译后锚点漂移 ${drift}px（版面已变化，高度 ${heightGrew}）`);
    ok.push(`锚点保持：重译撑高版面后漂移仅 ${drift}px`);

    // 10) 冒泡错误检查
    const errors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
      .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.entry?.text)
      .filter((t) => t && !/favicon|net::ERR_FILE_NOT_FOUND.*favicon/i.test(t));
    assert.deepEqual(errors, [], `页面报错: ${errors.join(' | ')}`);
    ok.push('无未捕获异常 / 控制台错误');

    console.log('\n=== e2e 全部通过 ===');
    for (const s of ok) console.log('  ✓', s);
  } finally {
    proc?.kill('SIGKILL');
    await llm.close();
    await pdf.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

run().catch((e) => {
  console.error('✗ e2e 失败:', e.message);
  process.exit(1);
});