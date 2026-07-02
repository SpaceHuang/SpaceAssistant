/** 内容含 LaTeX 命令（如 \frac、\boxed）时视为公式，避免误伤普通方括号文本 */
const LATEX_COMMAND = /\\(?:[a-zA-Z@]+|[^a-zA-Z\s])/

const LATEX_ENV_BLOCK =
  /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|displaymath)\}([\s\S]*?)\\end\{\1\}/g

const OUTER_BOX_COMMANDS = ['\\boxed', '\\fbox'] as const

function extractBalancedBraces(source: string, openBraceIndex: number): { inner: string; endIndex: number } | null {
  if (source[openBraceIndex] !== '{') return null
  let depth = 0
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return { inner: source.slice(openBraceIndex + 1, i), endIndex: i }
      }
    }
  }
  return null
}

/**
 * LLM 常用 \boxed{...} / \fbox{...} 标记「整段公式」，KaTeX 会再画一圈边框。
 * 仅当整段内容被单层 box 命令包裹时去掉外壳，保留公式内部的 \boxed{...}。
 */
export function unwrapOuterLatexBox(latex: string): string {
  const trimmed = latex.trim()
  for (const command of OUTER_BOX_COMMANDS) {
    const prefix = `${command}{`
    if (!trimmed.startsWith(prefix)) continue
    const extracted = extractBalancedBraces(trimmed, prefix.length - 1)
    if (!extracted) continue
    const rest = trimmed.slice(extracted.endIndex + 1).trim()
    if (rest === '') {
      return extracted.inner.trim()
    }
  }
  return latex
}

function toDisplayMath(inner: string): string {
  const trimmed = unwrapOuterLatexBox(inner.trim())
  return `$$\n${trimmed}\n$$`
}

/**
 * 将常见 LaTeX 公式分隔符转为 remark-math 可识别的 $ / $$ 语法。
 * LLM 输出常使用 \[ \]、\( \) 或裸 [ ] 包裹，而非 Markdown 标准的 $$。
 */
export function normalizeMarkdownMath(content: string): string {
  let text = content

  text = text.replace(LATEX_ENV_BLOCK, (_, _env, inner) => toDisplayMath(inner))

  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => toDisplayMath(inner))

  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$${inner.trim()}$`)

  text = text.replace(/^\[\s*\r?\n([\s\S]*?)\r?\n\]\s*$/gm, (match, inner: string) => {
    if (!LATEX_COMMAND.test(inner)) return match
    return toDisplayMath(inner)
  })

  return text
}
