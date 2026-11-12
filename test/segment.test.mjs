// 段落重建单测：fixture PDF（fixtures/sample.pdf）+ 手写用例（分栏 / 断词 / 小标题）。
//
// 注意 1：本机 ext4 上 Node 直接 import 大体积 mjs 会 SIGBUS（mmap 读取问题），
//         因此把 pdf.js 复制到 tmpfs（os.tmpdir）再导入。浏览器侧不受影响。
// 注意 2：测的就是 vendor/ 下浏览器实际加载的那个构建，保真度最高。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlocks, buildLexicon } from '../src/segment.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadPdfjs() {
  const dir = path.join(os.tmpdir(), 'pdfbilingual-pdfjs');
  const src = path.join(here, '..', 'vendor');
  for (const f of ['pdf.mjs', 'pdf.worker.mjs']) {
    const dst = path.join(dir, f);
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(path.join(src, f)).size) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(src, f), dst);
    }
  }
  return import(path.join(dir, 'pdf.mjs'));
}

const item = (str, x, y, w, font = 11) => ({ str, transform: [font, 0, 0, font, x, y], width: w, height: font });
const line = (str, x, y, font = 11) => [item(str, x, y, str.length * font * 0.48, font)];

async function fixturePdf(pdfjs) {
  const buf = fs.readFileSync(path.join(here, 'fixtures', 'sample.pdf'));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push({ tc: await page.getTextContent(), width: page.getViewport({ scale: 1 }).width });
  }
  const lexicon = buildLexicon(pages.map((p) => p.tc));
  return pages.map((p, i) => buildBlocks(p.tc, p.width, { pageIndex: i, lexicon }));
}

async function run() {
  const ok = [];

  /* ---------------------------- 合成：分栏与阅读顺序 ---------------------------- */
  {
    const tc = {
      items: [
        ...line('Left column line one.', 50, 700),
        ...line('Left column line two.', 50, 686),
        ...line('Left column line three.', 50, 672),
        ...line('Right column line one.', 320, 700),
        ...line('Right column line two.', 320, 686),
        ...line('Right column line three.', 320, 672),
      ],
    };
    const blocks = buildBlocks(tc, 600, { pageIndex: 0 });
    assert.equal(blocks.length, 2, '两栏应各成一段');
    assert.ok(blocks[0].text.startsWith('Left column line one'), '左栏先读');
    assert.ok(blocks[1].text.startsWith('Right column line one'), '右栏后读');
    ok.push('两栏切分 + 阅读顺序');
  }

  /* ------------------------- 合成：跨栏标题不掩盖栏缝 ------------------------- */
  {
    const tc = {
      items: [
        ...line('A Very Long Title Spanning Both Columns Entirely', 60, 760, 16),
        ...line('Left column line one.', 50, 700),
        ...line('Left column line two.', 50, 686),
        ...line('Right column line one.', 320, 700),
        ...line('Right column line two.', 320, 686),
      ],
    };
    const blocks = buildBlocks(tc, 600, { pageIndex: 0 });
    assert.ok(blocks.length >= 2);
    const left = blocks.find((b) => b.text.startsWith('Left column'));
    const right = blocks.find((b) => b.text.startsWith('Right column'));
    assert.ok(left && right, '标题跨栏时仍应识别出两栏');
    assert.ok(left.text.includes('two'), '左栏两行应合并');
    ok.push('跨栏标题下的分栏识别');
  ok.push('长双栏 + 居中公式：不跨栏合并、左右顺序正确');
  }

  /* -------------------- 合成：长双栏 + 居中公式（不跨栏合并） -------------------- */
  {
    const items = [];
    for (let i = 0; i < 12; i++) {
      items.push(...line(`Left column sentence number ${i} continues the argument.`, 40, 760 - i * 14, 9));
      items.push(...line(`Right column sentence number ${i} continues the argument.`, 380, 760 - i * 14, 9));
    }
    // 一条横跨两栏的居中公式行
    items.push(item('Attention(Q, K, V ) = softmax(QKT / sqrt(dk))V', 180, 600, 340, 11));
    const blocks = buildBlocks({ items }, 700, { pageIndex: 0 });
    assert.ok(blocks.length >= 2, '公式行不该吞掉正文');
    assert.ok(
      blocks.every((b) => !(b.text.includes('Left column') && b.text.includes('Right column'))),
      '左右栏不得被拼成一行'
    );
    const left = blocks.find((b) => b.text.startsWith('Left column sentence number 0'));
    assert.ok(left.text.includes('number 11'), `左栏 12 行应合成一段: ${left.text.slice(0, 120)}`);
    const idxLeft = blocks.indexOf(left);
    const idxRight = blocks.findIndex((b) => b.text.startsWith('Right column sentence number 0'));
    assert.ok(idxLeft < idxRight, '左栏应整体先于右栏');
  }

  /* ------------------------- 合成：行尾连字符两种处理 ------------------------- */
  {
    const tc = {
      items: [
        ...line('Patients showed inflam-', 50, 700),
        ...line('mation of the tissue.', 50, 686),
        ...line('We used high-', 50, 660),
        ...line('resolution fMRI here.', 50, 646),
      ],
    };
    const lex = new Set(['inflammation', 'high-resolution']);
    const blocks = buildBlocks(tc, 600, { pageIndex: 0, lexicon: lex });
    assert.ok(blocks[0].text.includes('inflammation'), `断词应拼接: ${blocks[0].text}`);
    assert.ok(!blocks[0].text.includes('inflam-'), '断词的连字符应去掉');
    assert.ok(blocks[1].text.includes('high-resolution'), `复合词应保留连字符: ${blocks[1].text}`);
    ok.push('连字符判定（断词 vs 复合词）');
  }

  /* --------------------------- 合成：无空行的小标题 --------------------------- */
  {
    const tc = {
      items: [
        ...line('Requirements:', 50, 700),
        ...line('The ideal candidate should hold a Master degree in a related field.', 50, 686),
        ...line('Previous experience with fMRI is a plus.', 50, 672),
      ],
    };
    const blocks = buildBlocks(tc, 600, { pageIndex: 0 });
    assert.equal(blocks.length, 2, 'Requirements: 应独立成块');
    assert.equal(blocks[0].type, 'heading');
    assert.ok(blocks[1].text.startsWith('The ideal candidate'));
    ok.push('行内小标题切分');
  }

  /* -------------------- 合成 PDF（2 页，fixtures/sample.pdf） -------------------- */
  const pdfjs = await loadPdfjs();
  const [p1, p2] = await fixturePdf(pdfjs);

  assert.equal(p1.length, 8, `第 1 页应为 8 块，实际 ${p1.length}`);
  assert.equal(p1[0].type, 'title', '首块应为标题');
  assert.ok(p1[0].text.includes('high-resolution fMRI'), '复合词连字符必须保留');
  assert.ok(!/highresolution/.test(p1[0].text), '不得把 high-resolution 拼错');
  assert.ok(p1.some((b) => b.type === 'heading' && b.text === 'Project description:'));
  assert.ok(p1.some((b) => b.type === 'heading' && b.text === 'Requirements:'));
  assert.ok(
    p1.some((b) => b.text.includes('high-resolution fMRI recordings')),
    '行尾 high- + resolution 断行应复原为复合词'
  );
  assert.ok(
    p1.every((b) => !/\s-\s/.test(b.text)),
    '不应出现悬挂连字符'
  );

  assert.equal(p2.length, 6, `第 2 页应为 6 块，实际 ${p2.length}`);
  assert.deepEqual(
    p2.map((b) => b.type),
    ['heading', 'para', 'heading', 'para', 'heading', 'para']
  );
  assert.equal(p2[0].text, 'Working environment:');
  assert.equal(p2[2].text, 'Start date:');
  assert.equal(p2[3].text, 'Fall 2027');
  ok.push('合成 PDF 两页结构（8 块 / 6 块，标题与三个小标题正确）');

  // 段落完整性：不丢内容
  const joined = [...p1, ...p2].map((b) => b.text).join(' ');
  for (const phrase of [
    'high-performance computing cluster',
    'contact@example.edu',
    'https://example.org/how-to-apply',
    'https://example.org/graduate-school',
  ]) {
    assert.ok(joined.includes(phrase), `内容缺失: ${phrase}`);
  }
  ok.push('正文无丢失（URL / 邮箱 / 引文）');

  console.log('\n=== segment.test 全部通过 ===');
  for (const s of ok) console.log('  ✓', s);
}

run().catch((e) => {
  console.error('✗ 失败:', e.message);
  process.exit(1);
});