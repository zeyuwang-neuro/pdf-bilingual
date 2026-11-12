# PDF 双语对照（Edge / Chrome 扩展）

点一下工具栏图标，当前页面的 PDF 就在新标签页里变成**逐段中英对照**：
左边是 PDF 原页渲染（版式、图、公式原样保留），右边是英文原文段落 + 紧跟的中文译文，两栏按页滚动联动。

用自己的 LLM 接口（默认 DeepSeek），译文缓存在本机，不经过任何第三方。

---

## 安装

**Edge**（Windows / macOS / Linux 通用，不需要上架商店）：

1. 拿到目录，二选一：
   - `git clone https://github.com/zeyuwang-neuro/pdf-bilingual.git`
   - 或下载 ZIP 解压，例如 `C:\Users\<你>\Projects\pdf-bilingual`
2. 地址栏打开 `edge://extensions`
3. 打开左下角「开发人员模式」
4. 点「加载解压缩的扩展」，选这个目录（含 `manifest.json` 的那层）
5. 首次会自动弹出设置页，填 API Key，点「测试连接」确认可用

Chrome 同理：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。

> Edge 里扩展加载后会提示「读取和更改你在所有网站上的数据」——因为要在任意 PDF 地址上取文件。
> 它不会向任何服务器发送你的浏览记录；唯一的出站请求是发给你自己填的 LLM 接口。

## 用法

| 操作 | 效果 |
|:--|:--|
| 打开 PDF → 点扩展图标 | 新标签页打开双语对照 |
| **网页里内嵌 PDF → 点扩展图标** | 自动找到页面里的那个 PDF（`iframe` / `embed` / `object`，就是 Edge 弹出 PDF 工具栏那种），翻它 |
| `Alt+Shift+T` | 同上（快捷键，可在 `edge://extensions/shortcuts` 改） |
| 把 `.pdf` 拖进阅读器窗口 | 翻译本地文件（`file://` 被浏览器权限挡住时用这个） |

界面上三个按钮：**重译本页**（忽略缓存重翻当前可见页）、**单栏/双栏**、**设置**。

## 设置

| 字段 | 说明 |
|:--|:--|
| 接口地址 | 填到 `/v1` 为止，程序自动拼 `/chat/completions`。DeepSeek：`https://api.deepseek.com/v1` |
| API Key | 存在 `chrome.storage.local`，明文，不上传 |
| 模型 | 默认 `deepseek-chat` |

任何 OpenAI 兼容端点都能用（OpenAI、Qwen、智谱、Moonshot、OpenRouter、本地 Ollama 的 `/v1`）。
不支持 `response_format` 的端点会自动去掉该参数重试。

## 两个容易踩的实现点

**1. 网页里内嵌的 PDF 怎么找。**
点图标时如果当前地址不是 `.pdf`，后台会往页面注入一段只读扫描（`src/findPdf.js` 的 `scanEmbeddedPdf`，
`chrome.scripting.executeScript` 序列化后执行，因此该函数不依赖任何外部变量），
按「元素可见面积」挑出最像正文的那个 PDF——`iframe`/`embed`/`object` 优先于页脚里的下载链接。
页内用 blob 渲染的（拿不到文件）会明确告诉你「请把文件拖进来」，而不是假装能翻。

**2. 左栏怎么跟着右栏滚。**
最初的写法是错的：`getBoundingClientRect()` 给的是视口坐标，直接拿它去赋 `scrollTop` 本身就是量纲错误，
而且只在「换页」时校正一次，译文一落地页面高度就变了，对齐立刻失效。现在的做法是：

- **连续映射**：每帧计算「参照线（右栏顶部往下 56px）落在第几页 + 页内进度」，
  再把左栏对应 canvas 用**相对位移**（当前位置 vs 期望位置）推过去，而不是每换一页硬跳一次。
- **当前页判定按「底边越过参照线」**，不是按「顶部在线上方」——段落长短差异大时，
  上一页可能整个已经翻过去了，按顶部判定会一直退回到上一页（这个 bug 真的出现过）。
- **高度变化就重新对一次**：`ResizeObserver` 盯着右栏内容高度，译文落地撑高版面时自动重算。
- **锚点保持**：写 DOM 前后各量一次正在读的那一段的视口位置，把位移补回 `scrollTop`，
  所以译文流式填充时你正在读的那一行不会往下跳（e2e 里量化验证：重译把版面撑高 8 倍，漂移 0px）。
- **左栏可被用户接管**：你手动滚左栏（wheel / pointerdown）就暂停跟随，再滚回右栏自动恢复。

## 它是怎么工作的

```
PDF URL ──fetch(credentials: include)──► ArrayBuffer
   │
   ├─ pdf.js 渲染每页到 canvas ─────────────────► 左栏
   │
   └─ pdf.js getTextContent() ──► 行段聚类 ──► 分栏检测 ──► 段落聚类
                                        │
                                        └──► 分批送 LLM（JSON 协议）──► 右栏逐段填空
```

段落重建的三步聚类（`src/segment.js`，纯函数，有单测）：

1. **行段**：同基线上按横向间隙切开——两栏页面上左右两栏常常共享同一基线，不切就会拼成一行
2. **分栏**：在页面中部找一条「最少行段穿过」的窄带作为栏缝；公式和图注这类跨栏小块不会掩盖栏缝
3. **段落**：按**本栏自身**的行距中位数切段（用全页中位数会被公式的小字号带偏），
   行尾连字符查全文档词表判断是复合词（`high-resolution` 保留）还是排版断词（`inflam-`+`mation` 拼回）

翻译（`src/translate.js`）：每批 ≤8 段 / ≤1500 字符，`temperature: 0`，要求模型输出 `{"t":[{"i":..,"zh":..}]}`。
**源语言不限**（英/德/法/…）→ 统一译成简体中文：职位广告常常一个站点里德英混排，提示词不能假定语种。
改提示词时必须递增 `src/translate.js` 的 `PROMPT_VERSION`，缓存键包含它，否则旧译文会被继续复用。
整批失败或个别段落缺失 → 自动降级为逐段纯文本请求；401/403 → 立即停止，不浪费额度。

缓存键 = `sha256(模型 + 提示词版本 + 段落原文)`，改模型即自动失效。

## 已知限制（都是设计选择，不是 bug）

- **扫描件不行**。没有文本层的 PDF 会提取不出字，本版本不做 OCR。
- **公式和表格会很难看**。公式会被拆成碎片段落；表格被拍平成文本流。第 1 版接受。
- **不做覆盖式（把中文压在原版面上）**。学术 PDF 中文比英文短 30–40%，硬塞会留白或挤压；
  逐段对照才是稳定解。左栏原页随时可看，需要精确版式时看左边即可。
- **PDF 文件本身不会被修改**，也不会在原生 PDF 阅读器里注入（浏览器不允许），产物永远是一个新标签页。
- **需要登录的 PDF**：用当前会话的 cookie 取文件，多数能行；遇到 403 请把文件拖进来。
- 左栏在窗口尺寸变化后不会重新按新宽度渲染（只是 CSS 缩放），保持清晰度优先。

## 测试

```bash
npm test              # 单测 + 端到端（约 40s）
npm test -- --no-e2e  # 只跑纯逻辑单测（约 1s）
```

- `test/segment.test.mjs` — 段落重建：真实 PDF + 分栏/断词/小标题合成用例
- `test/findPdf.test.mjs` — 内嵌 PDF 候选挑选、blob 排除、注入函数必须自包含
- `test/translate.test.mjs` — 翻译客户端：批量 JSON、缓存、`response_format` 降级、逐段降级、401 短路、abort
- `test/e2e.mjs` — 真 Chromium 加载扩展，用本地 mock LLM 跑完整链路：网页内嵌 PDF 扫描 → 14 段渲染 → 译文补齐
  → canvas 真有墨迹 → 滚动联动对齐 56px → 重译撑高版面后锚点漂移 0px → 无控制台异常
- `test/shot.mjs` — 截界面图，供人工检查排版：`node test/shot.mjs [pdf] [out.png]`

端到端用的是 Playwright 自带的 Chromium，路径可用 `CHROME=/path/to/chrome` 覆盖。

`test/fixtures/sample.pdf` 是**合成**的两页招聘广告（内容全部虚构），只为覆盖判定分支而存在：
首块按位置判为标题、`Project description:` 这类「短行+冒号」小标题、行尾 `high-` 断行复原成复合词。
需要改动它时跑 `python3 test/fixtures/make_fixture.py`（依赖 PyMuPDF），
注意保持「第 1 页 8 块 / 第 2 页 6 块」这个结构，否则单测与 e2e 会一起失败。

## 结构

```
manifest.json      MV3 清单
background.js      点图标 / 快捷键 → 打开阅读器
viewer.html/css/js 阅读器：左栏 pdf.js 渲染 + 右栏对照 + 滚动联动 + 翻译调度
options.html/js    API 设置与连通性测试
src/segment.js     段落重建（纯函数，可单测）
src/translate.js   LLM 客户端 + 缓存 + 降级
src/config.js      配置读写
src/findPdf.js     在页面 DOM 里找内嵌 PDF（注入函数，必须自包含）
test/              单测 + e2e + 截图脚本；fixtures/ 是合成 PDF
vendor/            pdf.js 4.10.38（含 cmaps / standard_fonts，支持中文 PDF）
```

零构建、零依赖：`vendor/` 里是 pdf.js 的现成构建，改完代码在 `edge://extensions` 点一次「重新加载」即可。

> **改过 `manifest.json`（新增/删除权限）后，「重新加载」在 Edge 上不可靠**：
> 表现是扩展看起来还在、但新权限不生效（例如 `chrome.scripting` 为 `undefined`，
> 内嵌 PDF 扫描直接静默失败、退回用网页 URL 去取，于是提示「这不是 PDF」）。
> 这时必须**移除扩展再重新加载解压目录**。

## 许可证

MIT，见 `LICENSE`。`vendor/` 下的 pdf.js 及其 cmaps / standard_fonts 来自
[Mozilla pdf.js](https://github.com/mozilla/pdf.js)，遵循 Apache-2.0（见 `vendor/LICENSE`）。
