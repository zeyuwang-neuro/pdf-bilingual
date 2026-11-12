// 依次跑单测与端到端；任何一步失败即整体失败。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = process.argv.includes('--no-e2e')
  ? ['segment.test.mjs', 'findPdf.test.mjs', 'translate.test.mjs']
  : ['segment.test.mjs', 'findPdf.test.mjs', 'translate.test.mjs', 'e2e.mjs'];

let failed = 0;
for (const file of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    failed++;
    console.error(`\n✗ ${file} 失败（${secs}s）`);
  } else {
    console.log(`\n✓ ${file} 通过（${secs}s）`);
  }
}
process.exit(failed ? 1 : 0);
