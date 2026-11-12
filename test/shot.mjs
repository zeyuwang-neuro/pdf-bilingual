// 开发辅助：截取阅读器真实界面，用于人工检查排版。
// 用法：node test/shot.mjs [pdf路径] [输出png]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockLLM } from './mock-llm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const CHROME =
  process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 参数可以是本地文件，也可以是 http(s) URL（调试真实站点时用）
const pdfFile = process.argv[2] || path.join(here, 'fixtures', 'sample.pdf');
const remoteUrl = /^https?:/i.test(pdfFile) ? pdfFile : null;
const outFile = process.argv[3] || '/tmp/viewer-shot.png';

const pdf = remoteUrl
  ? { port: 0, close: () => {} }
  : await new Promise((r) => {
      const s = http.createServer((req, res) => {
        const buf = fs.readFileSync(pdfFile);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length }).end(buf);
      });
      s.listen(0, '127.0.0.1', () => r({ port: s.address().port, close: () => s.close() }));
    });
const llm = await startMockLLM({ pretty: !process.env.RAW });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const port = 9600 + Math.floor(Math.random() * 200);
const proc = spawn(
  CHROME,
  ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
   '--password-store=basic', '--hide-scrollbars',
   `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
   `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
proc.stderr.on('data', () => {});

let list = null;
for (let i = 0; i < 80; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {}
  await sleep(200);
}
const extId = crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 950, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: `chrome-extension://${extId}/options.html` });
await sleep(900);
await evaluate(`chrome.storage.local.set({cfg:{baseUrl:${JSON.stringify(llm.url)},apiKey:'sk-test',model:'mock-shot',mode:'split'}})`);

const srcUrl = remoteUrl || `http://127.0.0.1:${pdf.port}/paper.pdf`;
const target = `chrome-extension://${extId}/viewer.html?src=${encodeURIComponent(srcUrl)}`;
await send('Page.navigate', { url: target });

for (let i = 0; i < 60; i++) {
  const done = await evaluate(`[...document.querySelectorAll('.blk .zh')].length && [...document.querySelectorAll('.blk .zh')].every(e=>!e.classList.contains('pending'))`);
  if (done) break;
  await sleep(400);
}
await sleep(600);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
const stat = await evaluate(`JSON.stringify({
  blocks: document.querySelectorAll('.blk').length,
  pages: document.querySelectorAll('#pages canvas').length,
  zh: document.querySelectorAll('.blk .zh').length,
  pending: document.querySelectorAll('.blk .zh.pending').length,
  overlay: document.getElementById('overlay').className,
  status: document.getElementById('status').textContent,
  title: document.getElementById('docTitle').textContent,
})`);
console.log('页面状态:', stat);
console.log('截图已保存:', outFile);

proc.kill('SIGKILL');
await llm.close();
pdf.close();
fs.rmSync(profile, { recursive: true, force: true });