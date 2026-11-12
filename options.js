import { getCfg, setCfg } from './src/config.js';
import { chatUrl } from './src/translate.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');

function say(text, kind = '') {
  msg.textContent = text;
  msg.className = kind;
}

(async () => {
  const cfg = await getCfg();
  $('baseUrl').value = cfg.baseUrl;
  $('apiKey').value = cfg.apiKey;
  $('model').value = cfg.model;
})();

function readForm() {
  return {
    baseUrl: $('baseUrl').value.trim() || 'https://api.deepseek.com/v1',
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'deepseek-chat',
  };
}

$('save').addEventListener('click', async () => {
  const cfg = await setCfg(readForm());
  say('已保存', 'ok');
  setTimeout(() => say(''), 2000);
  $('apiKey').value = cfg.apiKey;
});

$('test').addEventListener('click', async () => {
  const cfg = readForm();
  if (!cfg.apiKey) return say('先填 API Key', 'err');
  say('请求中…');
  try {
    const res = await fetch(chatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [{ role: 'user', content: '把 hello 翻译成中文，只输出译文。' }],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || '(空)';
    await setCfg(cfg);
    say(`连接正常：${text.slice(0, 40)}`, 'ok');
  } catch (e) {
    say(`失败：${e.message}`, 'err');
  }
});