// 一个假的 OpenAI 兼容服务端，用于离线测试翻译链路。
// 行为：按段落返回「中译：<前若干字>」，支持 response_format，可注入故障。
import http from 'node:http';

export function startMockLLM(opts = {}) {
  const state = {
    requests: 0,
    rejectJson: opts.rejectJson ?? false, // 返回 400 迫使客户端去掉 response_format 重试
    fail401: opts.fail401 ?? false,
    brokenJson: opts.brokenJson ?? false, // 返回无法解析的 JSON，逼出逐段降级
    pretty: opts.pretty ?? false, // 返回像样的中文，用于人工检查排版
    fatAfter: opts.fatAfter ?? Infinity, // 第 N 个请求之后返回 8 倍长的译文（模拟"译文落地撑高版面"）
  };

  const server = http.createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests++;
      if (state.fail401) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid key"}');
        return;
      }
      const json = JSON.parse(body);
      fakeZh._fat = state.requests > state.fatAfter;
      if (state.rejectJson && json.response_format) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"response_format unsupported"}');
        return;
      }
      const userMsg = json.messages.find((m) => m.role === 'user').content;
      let content;
      let parsed = null;
      try {
        parsed = JSON.parse(userMsg);
      } catch {
        /* 纯文本单段请求 */
      }
      if (Array.isArray(parsed?.t)) {
        const t = parsed.t.map((x) => (typeof x === 'string' ? x : String(x?.text ?? '')));
        content = state.brokenJson
          ? 'sorry, I cannot comply'
          : JSON.stringify({
              t: t.map((x, i) => ({ i, zh: state.pretty ? fakeZh(x, i) : `中译${i}：${x.slice(0, 12)}` })),
            });
      } else {
        content = `中译单段：${String(userMsg).slice(0, 12)}`;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        port,
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const FILLER = '这是用于检查排版的一段模拟译文，行高、字距、段落间距是否舒适，只有看到成段的中文才判断得出来。';

function fakeZh(src, i) {
  const bias = fakeZh._fat ? 8 : 1;
  const need = Math.max(24, Math.round(src.length * 0.55)) * bias;
  let out = FILLER;
  while (out.length < need) out += FILLER;
  return out.slice(0, need);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startMockLLM({ port: Number(process.argv[2]) || 11434 });
  console.log('mock LLM on', s.url);
}