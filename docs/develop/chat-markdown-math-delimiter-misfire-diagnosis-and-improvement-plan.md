# 聊天 / 文档 Markdown 数学定界符误判：诊断与改进计划

> 状态：待评审
> 范围：`src/renderer/utils/markdownPlugins.ts`、`src/renderer/components/Chat/ChatMarkdown.tsx`、`src/renderer/components/DetailPanel/MarkdownRenderView.tsx`、`src/shared/markdownMathNormalize.ts`、`src/renderer/services/markdownSearchProjection.ts`
> 触发会话：`461809a0-0f75-485c-9f99-a7d17fdf1339`

---

## 0. 结论摘要

用户报告的「消息列表格式乱码」不是字符编码损坏，而是**数学定界符误判**：

`remark-math` 以 `singleDollarTextMath: true`（默认值）运行，正文里**任意两个 `$`** 都会被配对成公式定界符。当定界符之间的内容无法通过 KaTeX 解析（例如含裸 `&&`）时，`rehype-katex` 会输出一个红色 `katex-error` 节点，**把这对定界符之间（本 case 约 415 字符）的全部内容吞进错误节点**，导致该段落之后整篇 Markdown 降级为裸文本。

修复分四层，其中前三层为 P0/P1，必须同时落地：

| 层 | 措施 | 解决什么 |
|---|---|---|
| L1 | `remarkMath` 关闭 `singleDollarTextMath` | 单 `$` 误配对（金额、shell 变量） |
| L2 | 渲染前做代码区感知的 `$` 转义守卫 | **`$$` 误配对**（L1 覆盖不到，实测确认） |
| L3 | 搜索投影改用 normalize 后的文本 | `data-search-fragment-id` 出现 `-1` |
| L4 | 数学解析失败降级为原样文本 | 任何残余误判不再吞段 |

**关键实测结论：仅关闭 `singleDollarTextMath` 不足以解决问题。** 同一文本块内出现两处 `$$` 时仍会被配对并吞段（见 §3.2 用例 5）。L1 与 L2 必须组合。

---

## 1. 问题陈述

### 1.1 现象

在**已完成**的助手消息（终态气泡，DOM 根为 `.sa-prose.chat-md-assistant`）中，正文某一处之后的全部内容塌成裸文本：

- `##` 不再成为标题，`**` 不再成为加粗，表格不再成表
- 取而代之的是一个红色错误块，其 `title` 为 `ParseError: KaTeX parse error: Expected 'EOF', got '&' at position 41…`
- 用户描述为「§2.1 之后整篇变成裸文本」

同一现象也出现在 **DetailPanel 文档预览**（`MarkdownRenderView`）中——即用户那份 60KB 规划文档被渲染时的表现。

### 1.2 需要纠正的两个误判

| 初判 | 是否成立 | 依据 |
|---|---|---|
| 特殊字符（Unicode 表格线 `─┬─`、箭头 `→`、`✅`）导致乱码 | ❌ | 这些字符在其他段落渲染正常 |
| 数据层 UTF-8 编码损坏 | ❌ | `messages.json` 为合法 UTF-8、无 BOM、无 `U+FFFD`，转义字节序列 0 匹配 |
| 「流式期间走纯文本渲染」 | ✅ 但无关 | 那是 `.chat-stream-plain` 路径，解释的是流式态看到的 raw markdown，与本次终态 HTML 是两条独立链路 |
| 「行内代码（code span）不受 KaTeX 保护」 | ❌ **已实测推翻** | code span 内的 `$` 完全受保护，见 §3.2 用例 6/7 |

---

## 2. 证据链

### 2.1 用户提供的 HTML 中的三个机器可读指纹

| 指纹 | 值 | 说明 |
|---|---|---|
| `style="color: rgb(204, 0, 0)"` | KaTeX 默认 `errorColor = #cc0000` | 确认是 **KaTeX 渲染错误**，而非其他渲染异常 |
| `<mi mathvariant="normal">‘</mi>` | 反引号被当作 math 标识符渲染为 `U+2018` | math 模式已吃掉本应是 code span 的内容 |
| `data-search-fragment-id="…|assistant-code:7:-1:inline"` | `codeIndex = -1` | 搜索投影与实际渲染内容不同源（见 §4.4） |

### 2.2 崩源链条（六步）

```
1. 原文某处「反引号数量不匹配」→ code span 未能闭合
2. 反引号降级为字面文本（故 HTML 里能直接看到反引号被当普通字符输出）
3. 原本应受 code span 保护的 `$$` 落入普通正文上下文
4. remark-math 命中该 `$$`，向同一文本块后方寻找匹配定界符，跨越约 415 字符
5. KaTeX 在 math 模式读到裸 `&&`（来自 `=='automation' &&`）——math 模式下 `&` 仅在 array/align 环境合法 → ParseError
6. rehype-katex 走 throwOnError:false 分支，产出 <span class="katex-error">，把定界符之间的全部原文吞进该节点
```

第 4 步的跨距是**同一文本块内**，不跨段落——实测确认 text math 不能跨空行（§3.2 用例 6）。这一点修正了「跨段吞并」的早期猜测。

### 2.3 复现（真实插件链）

使用与生产一致的链路：

```js
unified()
  .use(remarkParse)
  .use(remarkMath)              // ← 生产为裸用，即 singleDollarTextMath: true
  .use(remarkRehype)
  .use(rehypeKatex)
  .use(rehypeStringify)
```

最小复现输入：

```text
价格是 $5 到 $10 之间。
```

结果：`5 到` 被渲染成公式，stderr 产出 `unicodeTextInMathMode` 警告。

---

## 3. 实测矩阵

### 3.1 默认配置（`singleDollarTextMath: true`，当前生产状态）

| # | 输入 | katex | error | 判定 |
|---|---|---|---|---|
| 1 | `价格是 $5 到 $10 之间。` | ✅ | ❌ | **误判**：`5 到` 变公式（S2） |
| 2 | `行内 $$E=mc^2$$ 结束` | ✅ | ❌ | 正确 |
| 3 | 独立成行的 `$$…$$` 块 | ✅ display | ❌ | 正确 |
| 4 | `成本是 $100。`（单个孤 `$`） | ❌ | ❌ | 安全 |
| 5 | `原文含 /[*?$${}]/ 与 /a$$b/ 两处标记。` | ✅ | ❌ | **误判吞段**（S1） |
| 6 | `$$` 位于两段之一（另一段无 `$$`） | ❌ | ❌ | 安全（不跨段落） |
| 7 | `执行 T=$(mktemp -d) 然后 echo "$T" 结束。` | ✅ | ❌ | **误判**（S2） |
| — | code span 内含 `$` / `$$`（单、双反引号） | ❌ | ❌ | **安全** |

### 3.2 关闭单项美元（`singleDollarTextMath: false`，拟采用）

| # | 输入 | katex | display | 判定 |
|---|---|---|---|---|
| 1 | `价格是 $5 到 $10 之间。` | ❌ | ❌ | **修复** ✅ |
| 2 | `行内 $$E=mc^2$$ 结束` | ✅ | false | **能力保留** ✅ |
| 3 | 独立成行的 `$$…$$` 块 | ✅ | true | 能力保留 ✅ |
| 4 | `成本是 $100。` | ❌ | ❌ | 安全 |
| 5 | `原文含 /[*?$${}]/ 与 /a$$b/ 两处标记。` | ✅ | false | **仍未修复** ❌ |
| 6 | `$$` 跨段 | ❌ | ❌ | 安全 |
| 7 | `执行 T=$(mktemp -d) 然后 echo "$T" 结束。` | ❌ | ❌ | **修复** ✅ |

**结论**：

- L1（关闭单项）覆盖用例 1、7 这两类高频场景（金额、shell 变量），且**不损失行内公式能力**（用例 2 证明 `$$…$$` 行内仍渲染为 inline，`display=false`）。这是低成本高收益的一步。
- 但用例 5（同一文本块内两处 `$$`）依然吞段——**L1 无法覆盖**，必须由 L2 输入守卫解决。用例 5 正是本次线上故障的形态。
- 用例 2 同时排除了「关闭单项会导致行内公式全部变成块级」的担忧。

### 3.3 上游选项确认

`node_modules/mdast-util-math/lib/index.d.ts` 的类型定义原文：

```ts
type ToOptions = {
  /**
   * Whether to support math (text) with a single dollar (default: `true`).
   *
   * Single dollars work in Pandoc and many other places, but often interfere
   * with “normal” dollars in text.
   * If you turn this off, you can still use two or more dollars for text math.
   */
  singleDollarTextMath?: boolean | null | undefined;
};
```

上游文档明确承认该默认值「often interfere with "normal" dollars in text」，并说明关闭后仍可用两个及以上美元做文本数学——与 §3.2 用例 2 的实测一致。

---

## 4. 代码级根因

### 4.1 插件链裸用 `remarkMath`

`src/renderer/utils/markdownPlugins.ts:9-20`

```ts
/** 聊天与文件 Markdown 渲染共用的 remark 插件链 */
export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkSemanticStatusEmoji,
  remarkMath          // ← 未传 options，singleDollarTextMath 取默认 true
]

export const markdownRehypePlugins: PluggableList = [
  [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
  rehypeKatex         // ← 未传 options
]
```

### 4.2 两个渲染入口都开数学

该插件链被**两处**引用，且两处都未对数学做收窄：

| 入口 | 文件 | 数学状态 |
|---|---|---|
| 聊天助手正文 | `ChatBubble.tsx:146` → `ChatMarkdown.tsx` | `enableMath = true`（默认值），调用处**未传**，故恒为开 |
| 文档预览 | `DetailPanel/MarkdownRenderView.tsx:105` | 直接使用 `markdownRemarkPlugins`，**无任何开关** |

对照：`McpToolResultView.tsx:66` 已显式传 `enableMath={false}`，说明团队已知数学渲染存在风险面，但聊天与文档主路径未跟进。

`ChatMarkdown.tsx:309-310` 的开关实现：

```tsx
remarkPlugins={enableMath ? markdownRemarkPlugins : markdownRemarkPlugins.filter((plugin) => plugin !== remarkMath)}
rehypePlugins={enableMath ? markdownRehypePlugins : markdownRehypePlugins.filter((plugin) => plugin !== rehypeKatex)}
```

### 4.3 `normalizeMarkdownMath` 是单向补全，且会二次配对

`src/shared/markdownMathNormalize.ts`

它只做「把 `\[…\]`、`\(…\)`、`\begin{}`、裸 `[…]` 转成 `$` / `$$`」这一个方向，存在两个缺口：

**缺口 1：不识别 code span / code fence。** 转换在全文上做正则替换，不跳过代码区。

**缺口 2：`unwrapBoxedInDollarMath` 会对全文再做一次 `$…$` 配对扫描。**

```ts
text = text.replace(/\$((?:\\.|[^$\\])+)\$/g, (match, inner: string) => { ... })
```

该分支在 inner 不是外层 `\boxed{}` 时原样返回，因此通常不改写内容；但它对 `$` 的语义做了**与 remark-math 平行的第二处假设**，两处假设不一致时行为不可预期。

**缺口 3：产出形式是单 `$`。**

```ts
text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$${unwrapOuterLatexBox(inner.trim())}$`)
```

即使 L1 关闭了 `singleDollarTextMath`，这行产出的 `$…$` 也将**不再被识别为公式**——必须同步改为 `$$…$$`，否则 L1 会静默破坏 `\(…\)` 这一路的行内公式。

### 4.4 搜索投影与渲染内容不同源（`codeIndex = -1`）

`src/renderer/components/Chat/ChatMarkdown.tsx:73, 76`

```tsx
const rendered = useMemo(() => normalizeMarkdownMath(content), [content])
// ...
const codeOrder = useMemo(
  () => projectMarkdownForSearch(content, segmentIndex).codeFragments,   // ← 用原始 content
  [content, segmentIndex]
)
```

ReactMarkdown 的输入是 `rendered`，而搜索投影的输入是 `content`。两者在 normalize 改写文本后即失配。`markdownSearchProjection.ts` 内部同样自带一套 `$` 配对正则：

```ts
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g
const INLINE_MATH_RE = /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g
```

`code` 组件里 `codeOrder.findIndex(...)` 未命中即返回 `-1`，于是产出 `assistant-code:7:-1:inline` 这类畸形 fragmentId，并导致搜索高亮无法定位。

---

## 5. 影响面

### 5.1 触发条件

**必要条件**：同一文本块内、**非 code span 区域**出现 ≥ 2 个 `$`（普通配置），或 ≥ 2 处 `$$`（关闭单项后）。

**高危内容形态**：

| 形态 | 示例 |
|---|---|
| 金额 | `$5` … `$10` |
| shell 变量 | `$T`、`$(mktemp -d)`、`$R` |
| 正则字符类 | `/[*?$${}]/`、`[$]` |
| awk / sed 表达式 | `awk '{print $1, $2}'` |
| 模板字符串 | `${name}` |
| 反引号奇偶不匹配 | 任何导致 code span 断裂的编辑失误（本次触发器） |

### 5.2 严重性分级

| 级别 | 表现 | 影响 |
|---|---|---|
| **S1** | `katex-error` 吞段 | 整段之后 Markdown 全部降级为裸文本。本次线上故障 |
| **S2** | 内容被误渲染为公式 | 语义错误（例如 `5 到` 变成数学符号），虽不吞段但内容失真 |
| **S3** | `codeIndex = -1` | 搜索高亮定位失效，功能降级 |

### 5.3 受影响入口

- **聊天助手终态**：`ChatBubble` → `ChatMarkdown`（`enableMath` 默认 true）
- **文档预览**：`DetailPanel/MarkdownRenderView`（无开关，恒开）
- 不受影响：`McpToolResultView`（已显式 `enableMath={false}`）
- 流式态 `.chat-stream-plain` 不走 Markdown，天然免疫

### 5.4 技术文档场景被放大

中文技术文档中 `$` 出现频率远高于数学公式出现频率。金额、shell 片段、正则字符类都是日常内容，而 `remark-math` 的默认假设与之直接冲突。这是**结构性错配**，不是偶发。

---

## 6. 设计目标与约束

### 6.1 目标

| 编号 | 目标 | 度量 |
|---|---|---|
| G1 | 非公式语境中的 `$` 不再进入 math 模式 | §3.1 用例 1、5、7 全部 `katex=false` |
| G2 | 真公式渲染能力不退化 | `$$…$$` 行内与块级、`\[\]`、`\(\)`、`\begin{}` 全部用例通过 |
| G3 | 数学解析失败不吞段 | 人为构造失败用例，断言其余段落仍正常渲染 |
| G4 | 搜索投影与渲染同源 | 不再产出 `codeIndex = -1` 的 fragmentId |

### 6.2 约束

- 必须兼容**已落盘的历史消息**：不得依赖重写 `sessions/*/messages.json`
- 不得破坏 `ChatMarkdown.test.tsx`、`markdownMathNormalize.test.ts` 既有语义（允许按方案更新断言）
- 改动须同时覆盖**两个入口**（聊天 + 文档预览）
- `rehype-katex` 的 options 类型为 `Omit<katex.KatexOptions, "displayMode" | "throwOnError">` —— **`throwOnError` 无法通过 options 传入**，L4 需自研插件（详见 §8.4）
- 流式态 `.chat-stream-plain` 与本改动无关，不在本次范围

---

## 7. 方案设计

### 7.1 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A** 关闭单项美元 | `remarkMath({ singleDollarTextMath: false })` | 一行改动；覆盖金额/shell 类高频场景；实测不损失行内公式能力 | 无法覆盖同块内双 `$$`（用例 5） | **P0 采用** |
| **B** 输入守卫 | 渲染前按 CommonMark 切出代码区，区外转义未配对的 `$` | 覆盖 `$$` 配对；可从根上消除误判 | 需实现 code span 切分 | **P0 采用** |
| **C** 渲染侧降级 | 自研 rehype 插件，math 渲染失败时还原为文本 | 纵深防御，任何残余误判不吞段 | 无法修复「配对阶段」的错误；需自研插件 | **P2 采用** |
| **D** 只改文档 | 继续在文档里清理 `$` | 零代码风险 | 治标；每篇新文档都要人工清理；聊天消息无法清理 | ❌ 不作为主方案 |

**采用 A + B + C 组合，D 降级为临时缓解手段。**

### 7.2 L1：关闭单项美元（P0）

`src/renderer/utils/markdownPlugins.ts`

```ts
export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkSemanticStatusEmoji,
  [remarkMath, { singleDollarTextMath: false }]
]
```

**必须同步修改** `src/shared/markdownMathNormalize.ts`，把 `\(…\)` 的产出改为 `$$…$$`：

```ts
// 改前
text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$${unwrapOuterLatexBox(inner.trim())}$`)
// 改后
text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$$${unwrapOuterLatexBox(inner.trim())}$$`)
```

否则关闭单项后，`\(…\)` 这一路的行内公式会静默失效。

对应更新 `markdownMathNormalize.test.ts:14-16` 的断言：

```ts
it('converts \\( \\) inline delimiters', () => {
  expect(normalizeMarkdownMath(String.raw`\( E=mc^2 \)`)).toBe('$$E=mc^2$$')
})
```

### 7.3 L2：输入侧 `$` 守卫（P0，核心改造）

新增纯函数，建议置于 `src/shared/markdownMathNormalize.ts` 同目录的新文件 `src/shared/markdownDollarGuard.ts`，导出：

```ts
export function escapeStrayDollarDelimiters(content: string): string
```

**算法**：

1. **切出保护区**：按 CommonMark 规则扫描
   - fenced code block（``` 或 ~~~ 围栏，含缩进围栏）
   - inline code span（**反引号串长度必须与闭合串长度相等**，这是 CommonMark 的规则，也是本次故障触发点的正解）
   - 若反引号串找不到等长闭合串，则该串到行尾均为**字面文本**（非保护区）
2. **识别块级 `$$` 定界符**：独占一行（仅允许前后空白）的 `$$` 视为 display 定界符，成对出现时不参与行内配对
3. **行内配对判定**：在保护区之外，**逐行**统计剩余的 `$` 与 `$$` 出现次数
   - 数量为偶：保持原样（交还 remark-math）
   - 数量为奇：把该行内**最后一个** `$` 转义为 `\$`
4. **`$$` 优先**：同一位置同时可解释为 `$$` 或两个 `$` 时，优先按 `$$` 处理（与 remark-math 一致）

**要点**：

- 只需处理**同一行内**的配对——实测确认 text math 不跨段落，逐行判定即可覆盖风险且显著降低误伤
- 转义后 remark-math 不会开启数学，原文按字面输出，用户看到的就是他自己的 `$`
- 这是**保守策略**：宁可少渲染一个公式，不可吞掉一段文字

**调用位置**：须在 `normalizeMarkdownMath` **之后**调用（因为 normalize 会引入新的 `$`），两个入口都要接：

```ts
// ChatMarkdown.tsx
const rendered = useMemo(
  () => escapeStrayDollarDelimiters(normalizeMarkdownMath(content)),
  [content]
)

// MarkdownRenderView.tsx
escapeStrayDollarDelimiters(expandWikilinks(normalizeMarkdownMath(normalizeAsciiTables(content)), wikiRootPath))
```

### 7.4 L3：搜索投影同源（P1）

`src/renderer/components/Chat/ChatMarkdown.tsx`

```tsx
// 改前
const codeOrder = useMemo(
  () => projectMarkdownForSearch(content, segmentIndex).codeFragments,
  [content, segmentIndex]
)
// 改后
const codeOrder = useMemo(
  () => projectMarkdownForSearch(rendered, segmentIndex).codeFragments,
  [rendered, segmentIndex]
)
```

同时给 `code` 组件的 `findIndex` 加兜底：命中 `-1` 时不再产出 `…:-1:inline` 形式的 fragmentId，而是退回 `plainFragmentId`，并在 dev 下打一条 warn，避免畸形 ID 静默扩散。

### 7.5 L4：数学失败降级为文本（P2，纵深防御）

因 `rehype-katex` 的 options 排除了 `throwOnError`，需自研一个 rehype 插件，串在 `rehypeKatex` **之前**：

1. 遍历 hast，取 `className` 含 `math-inline` / `math-display` 的节点
2. 用 `katex.renderToString(value, { throwOnError: true, displayMode })` 试渲染
3. 成功 → 交给后续 `rehypeKatex` 正常处理（或直接替换为渲染结果）
4. 失败 → 将节点**替换为原始文本**（含 `$` 定界符），即「公式渲染不成功就显示原文」
5. 可选：给该文本加 `title`，暴露失败原因，便于用户与开发者定位

这样即使 L2 有漏网，最坏结果也只是「某段公式显示为字面文本」，**不会吞掉整段正文**。

### 7.6 L5：文档资产治理（P2）

`docs/develop/grep-recursive-search-capability-release-plan.md` 当前 `$`、`$$`、`[*?`、`}]` 均为 0 匹配——说明上一轮的「清理 `$`」已落盘。

该清理是**在 L2 缺位情况下的临时缓解**，其中一部分属于过度清理：

- §13 中被删掉的 `` `run "$R"` ``、`` `T=$(mktemp -d)` `` —— 这些位于 code span 内，**本身安全**（实测用例 7），可还原
- §2.1 第 2 行的崩源（反引号数量不匹配）——**这是真正的根因，必须修复，且不可还原**

**处置建议**：L2 落地并验证通过后，可评估还原 code span 内的 `$`。还原前必须确认该行反引号成对。

---

## 8. 改造点清单

| 编号 | 文件 | 改动 | 优先级 |
|---|---|---|---|
| T1 | `src/renderer/utils/markdownPlugins.ts` | `[remarkMath, { singleDollarTextMath: false }]` | P0 |
| T2 | `src/shared/markdownMathNormalize.ts` | `\(…\)` 产出改为 `$$…$$` | P0 |
| T3 | `src/shared/markdownDollarGuard.ts`（新增） | `escapeStrayDollarDelimiters` | P0 |
| T4 | `src/renderer/components/Chat/ChatMarkdown.tsx` | 接入 T3；`codeOrder` 改用 `rendered`；`-1` 兜底 | P0 / P1 |
| T5 | `src/renderer/components/DetailPanel/MarkdownRenderView.tsx` | 接入 T3 | P0 |
| T6 | 自研 rehype 插件（新增） | 数学失败降级为文本 | P2 |
| T7 | `src/shared/markdownMathNormalize.test.ts` | 更新 `\(…\)` 断言 | P0 |
| T8 | `src/renderer/components/Chat/ChatMarkdown.test.tsx` | 新增误判用例 | P0 |
| T9 | `docs/develop/grep-recursive-search-capability-release-plan.md` | 评估还原 code span 内 `$` | P2 |

---

## 9. 测试计划

### 9.1 单元测试：`escapeStrayDollarDelimiters`

| 输入 | 期望 |
|---|---|
| `价格是 $5 到 $10 之间。` | 两个 `$` 均被转义 |
| `成本是 $100。` | 单个孤 `$` 被转义 |
| `执行 `T=$(mktemp -d)` 然后 `echo "$T"`。` | code span 内**不**转义 |
| `` 原文含 `/[*?$${}]/` `` | code span 内**不**转义 |
| `原文含 /[*?$${}]/ 与 /a$$b/ 两处标记。` | 第二处 `$$` 被转义 |
| 反引号数量不匹配（`` ` `` + 文本 + `` ` `` + 文本） | 落为字面文本，其内 `$` **被**转义 |
| 独立成行的 `$$` `…` `$$` 块 | **不**转义 |
| `行内 $$E=mc^2$$ 结束` | **不**转义 |

### 9.2 组件测试：`ChatMarkdown`

新增用例（渲染后断言 DOM）：

| 用例 | 断言 |
|---|---|
| 金额文本 | 无 `.katex`，无 `.katex-error`，文本完整保留 `$5`、`$10` |
| 同块两处 `$$` | 无 `.katex-error`；该段之后的 `<h2>` 仍能被解析 |
| 崩源复现（反引号不匹配 + `&&`） | 无 `.katex-error`；整篇标题/表格结构完好 |
| 行内 `$$E=mc^2$$` | 有 `.katex`，无 `.katex-display` |
| 回归：`\[\]` / `\(\)` / `\begin{equation}` | 仍渲染为公式 |

**建议补充快照测试**：直接对整个文档 fixture 渲染后断言「`.katex-error` 数量为 0」，作为防回归闸门。

### 9.3 手工验证

1. 打开会话 `461809a0-0f75-485c-9f99-a7d17fdf1339`，确认历史消息渲染正常（验证历史数据兼容）
2. 在 DetailPanel 打开 `grep-recursive-search-capability-release-plan.md`，确认全文结构正常
3. 流式发送一段含 `$5 … $10` 的消息，分别观察流式态与终态

### 9.4 反引号奇偶校验（作为资产巡检脚本）

```bash
# 逐行统计反引号数量，输出奇数行（潜在 code span 断裂点）
awk '{ n=gsub(/`/,"`"); if (n%2==1) print NR": "n" 个反引号  "$0 }' docs/develop/grep-recursive-search-capability-release-plan.md
```

---

## 10. 验收标准

| 编号 | 标准 | 验证方式 |
|---|---|---|
| A1 | §9.1、§9.2 全部用例通过 | 自动化测试 |
| A2 | 会话 `461809a0` 历史消息无 `.katex-error` | 手工 + 快照 |
| A3 | 规划的 60KB 文档全文渲染：标题、表格、代码块结构完好 | 手工 |
| A4 | 行内与块级公式渲染能力与改动前一致 | §9.2 回归用例 |
| A5 | 搜索高亮不再出现 `codeIndex = -1` | 断言 fragmentId 格式 |
| A6 | MCP 工具结果视图行为无变化 | 既有测试 |

---

## 11. 风险与回滚

| 风险 | 描述 | 缓解 |
|---|---|---|
| R1 | 关闭单项美元导致既有行内公式失效 | 已实测 `$$…$$` 行内仍有效；T2 同步改写 `\(…\)` 产出；§9.2 回归用例覆盖 |
| R2 | 守卫过度转义，把真公式也转义掉 | 保守策略按行配对；块级 `$$` 给通行证；如仍误伤，提供开关可回退到只做 L1 |
| R3 | 插件链被文档预览共用，改动波及面大于预期 | 已知影响 2 个入口（§4.2），均在改造清单内；T5 显式接入 |
| R4 | `normalizeMarkdownMath` 产出变化影响已落盘文档 | normalize 在渲染时执行，不改写落盘数据，历史文档自动获得修复 |
| R5 | 搜索投影改用 `rendered` 后高亮偏移 | `rendered` 与 ReactMarkdown 输入一致，理论上更准；需 §9.2 覆盖 |
| R6 | 自研 rehype 插件（T6）引入新依赖风险 | 列为 P2，可独立回滚；主修复（T1–T5）不依赖它 |

**回滚**：T1 与 T2 互为配套，回滚需同时进行；T3–T5 为独立新增，可单点关闭（保留函数、不接入调用点）。

---

## 12. 实施顺序

```text
M0  取证与校验
    - 对再现文档跑反引号奇偶校验（§9.4），确认是否仍有断裂点
    - 记录当前基线快照（.katex-error 数量）

M1  L1 + T2（关闭单项 + normalize 产出对齐）
    - 改动小、可独立验证；先拿到用例 1/7 的修复
    - 跑 §9.2 回归用例，确认公式能力未退化

M2  L2 守卫（T3 + T4/T5 接入）
    - 核心改造，覆盖用例 5 这一类的吞段
    - 补齐 §9.1 全部单测

M3  L3 投影同源（T4 后半）
    - 消除 -1 fragmentId，修复搜索高亮

M4  L4 降级插件（T6）
    - 纵深防御，独立可回滚

M5  资产治理（T9）
    - 评估还原被过度清理的 code span 内容
```

**M1 与 M2 为本次必达**；M3 可并行；M4、M5 可排入后续迭代。

---

## 13. 待决策项

| 编号 | 待定问题 | 候选 |
|---|---|---|
| D1 | 行内公式的长期语法约定 | (a) 一律用 `$$…$$`；(b) 保留 `$…$` 但要求显式标注（如 front-matter 开关）；(c) 只支持块级 |
| D2 | 是否给用户暴露「解析失败显示原文」的提示样式 | (a) 静默显示原文；(b) 加 `title` 悬浮原因；(c) 加视觉标记 |
| D3 | 守卫的配对范围 | (a) 逐行（推荐，实测足够）；(b) 逐文本块；(c) 全文档 |
| D4 | 文档资产还原范围 | 仅还原 §13 的 shell 片段，还是全面复原 |
| D5 | 是否顺带治理 `markdownSearchProjection` 内重复的 `$` 配对正则（与 remark-math、normalize 共三处） | (a) 收敛为单一真源；(b) 暂不动 |

---

## 附录 A：复现与验证脚本

```js
// 用生产同款插件链验证误判是否消除
const render = async (md, opts) => String(
  await unified()
    .use(remarkParse)
    .use(remarkMath, opts)          // opts = { singleDollarTextMath: false }
    .use(remarkRehype)
    .use(rehypeKatex)
    .use(rehypeStringify)
    .process(md)
)

// 断言：非公式文本不应出现 class="katex"
await render('价格是 $5 到 $10 之间。', { singleDollarTextMath: false })
```

## 附录 B：本 case 关键时间线

| 时间（ms） | 事件 |
|---|---|
| 1790782562912 | 会话首条用户消息 |
| 1790783913758 | 助手消息 seq 11 首段开始 |
| 1790783917174 | 首段闭合（此段已进 Markdown 渲染） |
| 1790783931947 | 末段开始（含崩源内容） |
| 1790783940576 | 末段闭合、消息完成 |
| 1790812581654 | 规划文档被清理落盘（mtime 晚于会话） |

## 附录 C：相关文件索引

| 类别 | 路径 |
|---|---|
| 插件链 | `src/renderer/utils/markdownPlugins.ts` |
| 聊天渲染 | `src/renderer/components/Chat/ChatMarkdown.tsx` |
| 聊天气泡 | `src/renderer/components/Chat/ChatBubble.tsx` |
| 文档预览 | `src/renderer/components/DetailPanel/MarkdownRenderView.tsx` |
| 数学归一化 | `src/shared/markdownMathNormalize.ts` |
| 搜索投影 | `src/renderer/services/markdownSearchProjection.ts` |
| 上游类型 | `node_modules/mdast-util-math/lib/index.d.ts`、`node_modules/rehype-katex/lib/index.d.ts` |
| 受损资产 | `docs/develop/grep-recursive-search-capability-release-plan.md` |
