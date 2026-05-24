export type PlanDocExtractResult =
  | { kind: 'plan-doc'; content: string }
  | { kind: 'plan-abort'; content: string }
  | { kind: 'none' }

const PLAN_DOC_RE = /<plan-doc>([\s\S]*?)<\/plan-doc>/i
const PLAN_ABORT_RE = /<plan-abort>([\s\S]*?)<\/plan-abort>/i
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/m
const PLAN_GOAL_HEADING_RE = /^##\s+(?:1\.\s*)?目标\s*$/im

/** 无 XML 标签时：含 YAML frontmatter 且含「## 1. 目标」或「## 目标」章节则视为 plan-doc */
export function looksLikePlanMarkdownWithoutTags(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (!FRONTMATTER_RE.test(trimmed)) return false
  return PLAN_GOAL_HEADING_RE.test(trimmed)
}

export function extractPlanMarkersFromText(text: string): PlanDocExtractResult {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'none' }

  const abortMatch = PLAN_ABORT_RE.exec(trimmed)
  if (abortMatch) {
    return { kind: 'plan-abort', content: abortMatch[1]!.trim() }
  }

  const docMatch = PLAN_DOC_RE.exec(trimmed)
  if (docMatch) {
    return { kind: 'plan-doc', content: docMatch[1]!.trim() }
  }

  if (looksLikePlanMarkdownWithoutTags(trimmed)) {
    return { kind: 'plan-doc', content: trimmed }
  }

  return { kind: 'none' }
}

export function extractPlanMarkersFromAssistantContent(content: unknown[]): PlanDocExtractResult {
  let text = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') text += t
    }
  }
  return extractPlanMarkersFromText(text)
}
