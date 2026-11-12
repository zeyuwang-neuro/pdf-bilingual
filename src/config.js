// 配置读写。放在 chrome.storage.local（扩展页面可直接访问）。

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  mode: 'split', // split | single
};

export async function getCfg() {
  const { cfg } = await chrome.storage.local.get('cfg');
  return { ...DEFAULTS, ...(cfg || {}) };
}

export async function setCfg(patch) {
  const next = { ...(await getCfg()), ...patch };
  await chrome.storage.local.set({ cfg: next });
  return next;
}