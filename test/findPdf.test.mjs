// 内嵌 PDF 扫描：pickBest 是纯函数，scanEmbeddedPdf 在 e2e 里用真浏览器验证。
import assert from 'node:assert/strict';
import { pickBest, scanEmbeddedPdf } from '../src/findPdf.js';

const ok = [];

assert.equal(pickBest([]), null, '空列表应返回 null');
assert.equal(pickBest(null), null);
ok.push('空输入返回 null');

assert.equal(pickBest([{ url: 'https://a/x.pdf', area: 0, kind: 'a' }]).url, 'https://a/x.pdf');
ok.push('单个链接候选');

// 面积大的优先：页面里同时有 iframe 和大图链接时，选真正的承载元素
assert.equal(
  pickBest([
    { url: 'https://a/small.pdf', area: 100, kind: 'a' },
    { url: 'https://a/big.pdf', area: 900, kind: 'iframe' },
  ]).url,
  'https://a/big.pdf'
);
ok.push('面积优先');

// blob 优先被排除：blob 取不到文件，有真地址就用真地址
assert.equal(
  pickBest([
    { url: 'blob:https://a/1', area: 1e6, kind: 'iframe' },
    { url: 'https://a/x.pdf', area: 10, kind: 'a' },
  ]).url,
  'https://a/x.pdf'
);
ok.push('排除 blob/data 候选');

// 全是 blob 时仍返回它，交给上层决定回退（background 会转成 reason=blob）
assert.equal(pickBest([{ url: 'blob:https://a/1', area: 5, kind: 'iframe' }]).url, 'blob:https://a/1');
ok.push('只有 blob 时原样返回');

// 面积全为 0（隐藏元素）时，优先非链接的承载元素
assert.equal(
  pickBest([
    { url: 'https://a/link.pdf', area: 0, kind: 'a' },
    { url: 'https://a/embed.pdf', area: 0, kind: 'embed' },
  ]).kind,
  'embed'
);
ok.push('隐藏元素时优先 iframe/embed');

// 这个函数要被序列化后注入页面：不能引用任何外部标识符
const src = scanEmbeddedPdf.toString();
assert.ok(src.startsWith('function scanEmbeddedPdf'), '必须是函数声明，便于 executeScript 序列化');
assert.ok(!/pickBest|pickedBest/.test(src), '不得引用外部函数');
ok.push('注入函数自包含（无自由变量）');

console.log('\n=== findPdf.test 全部通过 ===');
for (const s of ok) console.log('  ✓', s);