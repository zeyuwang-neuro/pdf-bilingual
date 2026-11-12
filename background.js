// 点图标 / 快捷键 → 在新标签页打开翻译阅读器。
// 当前页本身不是 PDF 时，注入脚本找页面里内嵌的 PDF（Edge 显示 PDF 工具栏那种）。

import { scanEmbeddedPdf, pickBest } from './src/findPdf.js';

const VIEWER = chrome.runtime.getURL('viewer.html');

function isWebUrl(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url) && !url.startsWith(VIEWER);
}

function isPdfUrl(url) {
  return typeof url === 'string' && /\.pdf($|[?#&])/i.test(url);
}

async function scanTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scanEmbeddedPdf });
    return Array.isArray(res?.result) ? res.result : [];
  } catch {
    return null; // 无法注入（edge:// 、商店页、权限不足）
  }
}

async function resolveTarget(tab) {
  const url = tab?.url;
  if (!isWebUrl(url)) return { url: '' };
  if (isPdfUrl(url)) return { url };

  const found = await scanTab(tab.id);
  if (!found) return { url }; // 注入不了（edge:// 等），退回原地址让阅读器自己判断

  const best = pickBest(found);
  if (best && !/^(blob|data):/i.test(best.url)) return { url: best.url };
  if (found.length) return { url: '', reason: 'blob' }; // 有 PDF，但页内 blob 渲染，取不到文件
  return { url };
}

async function openViewer(target) {
  const qs = target.url
    ? '?src=' + encodeURIComponent(target.url)
    : target.reason
      ? '?reason=' + encodeURIComponent(target.reason)
      : '';
  await chrome.tabs.create({ url: VIEWER + qs });
}

async function handle(tab) {
  await openViewer(await resolveTarget(tab));
}

chrome.action.onClicked.addListener(handle);

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'translate-pdf') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await handle(tab);
});

// 首次装上还没填 key，直接把设置页打开，省得用户点了图标一头雾水
chrome.runtime.onInstalled.addListener(async () => {
  const { cfg } = await chrome.storage.local.get('cfg');
  if (!cfg?.apiKey) chrome.runtime.openOptionsPage();
});