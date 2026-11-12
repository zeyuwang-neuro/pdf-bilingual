# 开发说明

面向改代码的人。用户文档在 [README](../README.md)。

## 形态

零构建、零依赖。所有文件就是浏览器实际加载的文件，`vendor/` 里放的是 pdf.js 4.10.38 的现成构建
（含 `cmaps` / `standard_fonts`，中文 PDF 才不缺字）。改完代码在 `edge://extensions` 点一次「重新加载」。

```
manifest.json      MV3 清单
background.js      点图标 / 快捷键 → 打开阅读器（含内嵌 PDF 解析）
viewer.html/css/js 阅读器：左栏渲染 + 右栏对照 + 滚动联动 + 翻译调度
options.html/js    API 设置与连通性测试
src/segment.js     段落重建（纯函数，可单测）
src/translate.js   LLM 客户端 + 缓存 + 降级
src/config.js      配置读写
src/findPdf.js     在页面 DOM 里找内嵌 PDF（注入函数，必须自包含）
test/              单测 / e2e / 截图脚本；fixtures/ 是合成 PDF
```

```
PDF URL ──fetch(credentials: include)──► ArrayBuffer
   │
   ├─ pdf.js 渲染每页到 canvas ─────────────────► 左栏
   │
   └─ pdf.js getTextContent() ──► 行段聚类 ──► 分栏检测 ──► 段落聚类
                                        │
                                        └──► 分批送 LLM（JSON 协议）──► 右栏逐段填空
```

## 段落重建（`src/segment.js`）

三步聚类，纯函数，输入 pdf.js 的 `textContent.items` + 页宽：

1. **行段**：同基线上按横向间隙切开。两栏页面左右两栏常常共享同一基线，不切就会拼成一行。
2. **分栏**：在页面中部找一条「最少行段穿过」的窄带作为栏缝。用行段而非 items 计数，
   公式和图注这类跨栏小块不会掩盖真正的栏缝；多处同样稀疏时取最靠页心的那个。
3. **段落**：按**本栏自身**的行距中位数切段——用全页中位数会被公式的小字号带偏。
   行尾连字符查全文档词表（`buildLexicon`）判断是复合词（`high-resolution` 保留）
   还是排版断词（`inflam-` + `mation` 拼回）。词表未命中时保留连字符：
   宁可多一个连字符，也不要吃掉真复合词。

块类型：短行 + 冒号结尾、编号标题、字号明显大于正文 → `heading`；首页首块按位置判为 `title`
（多数 PDF 标题只靠粗体区分，而 pdf.js 的 `transform` 里拿不到字重）。

## 内嵌 PDF 扫描（`src/findPdf.js`）

当前地址不是 `.pdf` 时，`background.js` 通过 `chrome.scripting.executeScript` 注入
`scanEmbeddedPdf`。**这个函数被序列化后在页面里单独执行，因此不能引用任何外部变量或 import**
（有单测盯着这条约束）。它按元素可见面积排出候选，`iframe` / `embed` / `object` 优先于页脚里的下载链接。

页内 blob 渲染的 PDF 拿不到文件，此时明确告诉用户「把文件拖进来」，而不是假装能翻。

## 翻译与缓存（`src/translate.js`）

- 每批 ≤ 8 段 / ≤ 1500 字符，`temperature: 0`，要求模型按 `{"t":[{"i":..,"zh":..}]}` 回答。
- **源语言不限**（英/德/法/…）统一译成简体中文：招聘站点常常一个页面里德英混排，提示词不能假定语种。
- 改提示词**必须递增 `PROMPT_VERSION`**。缓存键是 `sha256(模型 + 提示词版本 + 段落原文)`，
  否则旧译文会被继续复用。
- 整批失败或个别段落缺失 → 自动降级为逐段纯文本请求；401/403 → 立即停止，不浪费额度。
- 端点不支持 `response_format` → 去掉该参数重试。

## 滚动联动（`viewer.js`）

这一块历任实现都栽过，现在的做法：

- **连续映射**：每帧算「参照线（右栏顶部往下 56px）落在第几页 + 页内进度」，
  再把左栏对应 canvas 用**相对位移**推到期望位置，而不是每换一页硬跳一次。
- **当前页按「底边越过参照线」判定**，不是按「顶部在线上方」——段落长短差异大时上一页可能已经整个翻过去了，
  按顶部判会一直退回上一页。
- **高度变化重新对齐**：`ResizeObserver` 盯右栏内容高度，译文落地撑高版面时重算。
- **锚点保持**：写 DOM 前后各量一次正在读的段落的视口位置，把位移补回 `scrollTop`，
  译文流式填充时正在读的那行不会往下跳。
- **用户可接管**：手动滚左栏（wheel / pointerdown）暂停跟随，滚回右栏恢复。

e2e 对这些有量化断言（对齐偏移 56px、重译撑高版面后漂移 0px），改这里必须跑 `npm test`。

## 测试

```bash
npm test              # 单测 + 端到端（约 40s）
npm test -- --no-e2e  # 只跑纯逻辑单测（约 1s）
```

- `test/segment.test.mjs` — 段落重建：fixture PDF + 手写用例（分栏 / 跨栏标题 / 断词 / 小标题）
- `test/findPdf.test.mjs` — 候选挑选、blob 排除、注入函数必须自包含
- `test/translate.test.mjs` — 批量 JSON、缓存、`response_format` 降级、逐段降级、401 短路、abort
- `test/e2e.mjs` — 真 Chromium 加载扩展 + 本地 mock LLM 跑完整链路
- `test/shot.mjs` — 截界面图供人工检查排版：`node test/shot.mjs [pdf] [out.png]`

e2e 用的是 Playwright 自带的 Chromium，路径可用 `CHROME=/path/to/chrome` 覆盖
（`shot.mjs` 同样认这个变量）。默认路径写死了 `chromium-1243`，Playwright 版本变了要改。

`test/fixtures/sample.pdf` 是**内容全部虚构**的两页招聘广告，只为覆盖判定分支：
首块按位置判标题、`Project description:` 这类「短行 + 冒号」小标题、行尾 `high-` 断行复原。
改动它就跑 `python3 test/fixtures/make_fixture.py`（需要 PyMuPDF），并保持
**第 1 页 8 块 / 第 2 页 6 块**——单测和 e2e 都按这个数断言。

## 权限与重新加载

`manifest.json` 里 `host_permissions` 是 `<all_urls>`（要在任意 PDF 地址上取文件），
权限变更后 Edge 的「重新加载」不可靠：扩展看起来还在，但新权限不生效
（典型现象是 `chrome.scripting` 为 `undefined`，内嵌 PDF 扫描静默失败，退回用网页 URL 去取，
于是提示「这不是 PDF」）。这时必须**移除扩展再重新加载解压目录**。