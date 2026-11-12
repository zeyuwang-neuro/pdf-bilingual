// 翻译客户端单测：不联网，打本机的 mock LLM。
import assert from 'node:assert/strict';
import { startMockLLM } from './mock-llm.mjs';
import {
  translateBlocks,
  parseTranslations,
  chatUrl,
  FatalApiError,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
} from '../src/translate.js';

const blocks = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, text: `Paragraph number ${i} about hippocampal replay and memory.` }));

async function run() {
  const results = [];

  // 1. chatUrl 拼接
  assert.equal(chatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatUrl('https://x.dev/v1/'), 'https://x.dev/v1/chat/completions');
  assert.equal(chatUrl('https://x.dev/v1/chat/completions'), 'https://x.dev/v1/chat/completions');

  // 1.5 提示词必须与源语言无关（曾经写死 English，德语职位广告会翻坏）
  assert.match(SYSTEM_PROMPT, /Simplified Chinese/, '目标语言必须是简体中文');
  assert.match(SYSTEM_PROMPT, /any other language/, '必须声明源语言不限');
  assert.doesNotMatch(SYSTEM_PROMPT, /English (paragraph|text|sentence)/i, '不得假定源语言是英语');
  assert.ok(PROMPT_VERSION >= 2, '改过提示词后 PROMPT_VERSION 必须递增，否则旧译文会被复用');
  results.push('提示词与源语言无关');

  // 2. 解析容错
  assert.equal(parseTranslations('{"t":[{"i":0,"zh":"甲"},{"i":1,"zh":"乙"}]}').get(1), '乙');
  assert.equal(parseTranslations('```json\n{"t":[{"i":0,"zh":"丙"}]}\n```').get(0), '丙');
  assert.equal(parseTranslations('好的，结果如下：{"t":[{"i":0,"zh":"丁"}]} 以上。').get(0), '丁');
  assert.equal(parseTranslations('[{"i":0,"zh":"戊"}]').get(0), '戊');
  assert.equal(parseTranslations('{"zh":"己"}').get(0), '己');
  assert.equal(parseTranslations('total garbage').size, 0);
  results.push('parse: 6/6');

  // 3. 正常翻译（JSON 批量）+ 回调
  let llm = await startMockLLM();
  const got = new Map();
  const cfg = { baseUrl: llm.url, apiKey: 'sk-test', model: 'mock-1' };
  let stats = await translateBlocks(blocks(3), cfg, { onResult: (b, zh) => got.set(b.id, zh) });
  assert.equal(got.size, 3, '应翻译 3 段');
  assert.ok(got.get('b0').startsWith('中译0'), '批量 JSON 路径');
  assert.equal(stats.failed, 0);
  results.push('batch json: ok');

  // 4. 缓存命中（model 相同 → 全部命中，不再发请求）
  const before = llm.state.requests;
  got.clear();
  stats = await translateBlocks(blocks(3), cfg, { onResult: (b, zh) => got.set(b.id, zh) });
  assert.equal(llm.state.requests, before, '缓存命中不应产生请求');
  assert.equal(got.size, 3);
  assert.equal(stats.cached, 3);
  results.push('cache hit: ok');

  // 5. useCache=false 强制重译
  got.clear();
  await translateBlocks(blocks(2), cfg, { useCache: false, onResult: (b, zh) => got.set(b.id, zh) });
  assert.equal(got.size, 2);
  results.push('cache bypass: ok');
  await llm.close();

  // 6. 端点拒绝 response_format → 自动去掉重试
  llm = await startMockLLM({ rejectJson: true });
  got.clear();
  stats = await translateBlocks(blocks(2), { baseUrl: llm.url, apiKey: 'k', model: 'mock-2' }, { onResult: (b, zh) => got.set(b.id, zh) });
  assert.equal(got.size, 2, '应降级成功');
  assert.equal(stats.failed, 0);
  await llm.close();
  results.push('response_format fallback: ok');

  // 7. 模型吐垃圾 → 逐段纯文本降级
  llm = await startMockLLM({ brokenJson: true });
  got.clear();
  stats = await translateBlocks(blocks(2), { baseUrl: llm.url, apiKey: 'k', model: 'mock-3' }, { onResult: (b, zh) => got.set(b.id, zh) });
  assert.equal(got.size, 2, '应逐段降级补齐');
  assert.ok([...got.values()][0].startsWith('中译单段'), '走的是纯文本降级');
  assert.equal(stats.failed, 0);
  await llm.close();
  results.push('per-block fallback: ok');

  // 8. 401 → 致命错误，立即抛出，不逐段重试
  llm = await startMockLLM({ fail401: true });
  const start = llm.state.requests;
  await assert.rejects(
    () => translateBlocks(blocks(4), { baseUrl: llm.url, apiKey: 'bad', model: 'mock-4' }, {}),
    (e) => e instanceof FatalApiError
  );
  assert.ok(llm.state.requests - start <= 3, `401 后应停止重试，实际请求 ${llm.state.requests - start} 次`);
  await llm.close();
  results.push('401 fatal: ok');

  // 9. Abort
  llm = await startMockLLM();
  const ac = new AbortController();
  ac.abort();
  const s9 = await translateBlocks(blocks(3), { baseUrl: llm.url, apiKey: 'k', model: 'mock-5' }, { signal: ac.signal });
  assert.equal(s9.done, 0, '已 abort 不应产生译文');
  await llm.close();
  results.push('abort: ok');

  console.log('\n=== translate.test 全部通过 ===');
  for (const r of results) console.log('  ✓', r);
}

run().catch((e) => {
  console.error('✗ 失败:', e.message);
  process.exit(1);
});