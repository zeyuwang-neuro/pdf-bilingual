#!/usr/bin/env python3
"""生成 test/fixtures/sample.pdf —— 测试用合成 PDF（全部虚构内容，无第三方材料）。

只在需要重新生成 fixture 时才跑：
    uv run --with pymupdf python test/fixtures/make_fixture.py

它刻意覆盖 segment.js 的几个判定分支，结构必须保持：
  * 第 1 页 8 块 / 第 2 页 6 块（segment.test.mjs、e2e.mjs 按此断言）
  * 首块是标题（靠位置判定，不靠字号）
  * `Project description:` `Requirements:` `Working environment:` `Start date:`
    `Application procedure:` 这类「短行 + 冒号」小标题必须被切成独立块
  * 行尾 `high-` / `resolution` 断行 → 查全文档词表后保留复合词连字符
  * 正文里出现 URL 与邮箱，验证拼接不吞字符
"""
import sys
from pathlib import Path

import fitz

W, H = 595, 842          # A4
MARGIN = 62
BODY = 10.5
TITLE = BODY             # 刻意与正文同字号：真实 PDF 的标题常只靠粗体区分，
                         # 而 pdf.js 的 transform 里拿不到字重 —— 段首块须按位置判定为 title
LEAD = 15.0              # 行距：必须小于 lineGap*1.45，否则同一段会被拆开
PARA_GAP = 30.0          # 段间距：必须大于 LEAD*1.45
HEAD_GAP = 28.0

TITLE_TEXT = (
    "Open PhD position in cognitive neuroengineering: decoding visual attention "
    "with high-resolution fMRI and artificial neural networks"
)

# (page, kind, text) —— kind: title / head / para
CONTENT = [
    (1, "title", TITLE_TEXT),
    (1, "para",
     "The Laboratory of Synthetic Neuroimaging (Prof. A. Example: https://example.org/lab) "
     "is opening a new PhD position on the neural mechanisms of visual attention, studied with "
     "artificial neural networks and high-"),
    # 上面这段故意以 "high-" 结尾，下一行接着写，用来测断词判定
    (1, "cont", "resolution fMRI recordings of the human visual cortex."),
    (1, "head", "Project description:"),
    (1, "para",
     "The project combines model-based analyses of fMRI signals with behavioural experiments in "
     "healthy volunteers and patients with attentional deficits. The candidate will build "
     "encoding models that predict voxel-wise responses from image statistics and will test "
     "whether the same models account for attention-driven gain changes in early visual areas. "
     "Data collection takes place at the institute's imaging centre, and the analyses are "
     "developed in an open-source software stack."),
    (1, "para",
     "This position is embedded in a larger research programme on attention and consciousness, "
     "and benefits from shared computing infrastructure and weekly methods seminars."),
    (1, "head", "Requirements:"),
    (1, "para",
     "Applicants should hold a Master degree in neuroscience, computer science, physics or a "
     "related field, have strong quantitative skills (Python, PyTorch), and be comfortable with "
     "scientific writing. Prior work with fMRI preprocessing pipelines is an advantage but not a "
     "requirement. Please see https://example.org/how-to-apply for the formal procedure."),
    (1, "para",
     "The position is funded for four years and includes a travel budget for international "
     "conferences. Part-time arrangements can be discussed."),
    (2, "head", "Working environment:"),
    (2, "para",
     "The successful applicant will join a small interdisciplinary team with access to a 3T "
     "scanner, a high-performance computing cluster and a dedicated behavioural testing lab. "
     "The working language is English, and supervision is shared between two senior researchers. "
     "Inquiries may be sent to contact@example.edu."),
    (2, "head", "Start date:"),
    (2, "para", "Fall 2027"),
    (2, "head", "Application procedure:"),
    (2, "para",
     "Interested candidates submit their application through the graduate school portal "
     "(https://example.org/graduate-school) and name two referees. Applications are reviewed "
     "on a rolling basis until the position is filled."),
]


def wrap(text, size, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        cand = f"{cur} {w}".strip()
        if fitz.get_text_length(cand, fontname="helv", fontsize=size) <= maxw or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def main(out: Path):
    doc = fitz.open()
    page = doc.new_page(width=W, height=H)
    cur_page, y = 1, MARGIN
    maxw = W - 2 * MARGIN
    prev_kind = None

    for pg, kind, text in CONTENT:
        if pg != cur_page:
            page = doc.new_page(width=W, height=H)
            cur_page, y = pg, MARGIN
            prev_kind = None

        if kind != "cont":  # cont = 上一段的延续行，紧接其上，不加段间隔
            y += {"title": 0, "head": HEAD_GAP, "para": PARA_GAP}[kind]

        size = TITLE if kind in ("title", "head") else BODY
        for line in wrap(text, size, maxw):
            page.insert_text((MARGIN, y), line, fontname="helv", fontsize=size)
            y += LEAD if kind != "title" else LEAD * 1.25
        prev_kind = kind

    doc.set_metadata({"title": "", "author": "", "creator": "", "producer": ""})
    doc.save(out)
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(doc)} pages)")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("sample.pdf"))