import type { PlanApprovalSummary } from '../../src/shared/planTypes'

const PLACEHOLDER_RE = /\b(TODO|TBD|待确认|待补充)\b/i

export type ParsedPlanFrontmatter = {
  plan_id?: string
  status?: string
  version?: number
  steps_total?: number
  steps_completed?: number
}

export type ParsedPlanFile = {
  frontmatter: ParsedPlanFrontmatter
  body: string
  title: string
  steps: string[]
}

function parseFrontmatter(raw: string): { frontmatter: ParsedPlanFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(raw)
  if (!match) {
    return { frontmatter: {}, body: raw }
  }
  const fm: ParsedPlanFrontmatter = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.+)$/i.exec(line.trim())
    if (!m) continue
    const key = m[1]!
    const val = m[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (key === 'plan_id') fm.plan_id = val
    else if (key === 'status') fm.status = val
    else if (key === 'version') fm.version = Number(val)
    else if (key === 'steps_total') fm.steps_total = Number(val)
    else if (key === 'steps_completed') fm.steps_completed = Number(val)
  }
  return { frontmatter: fm, body: match[2]! }
}

function extractSection(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im')
  const m = re.exec(body)
  return m ? m[1]!.trim() : ''
}

function extractTitle(body: string): string {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? m[1]!.trim() : '未命名计划'
}

function extractCheckboxSteps(body: string): string[] {
  const section = extractSection(body, '4. 执行步骤') || extractSection(body, '执行步骤')
  const lines = section.split(/\r?\n/)
  const steps: string[] = []
  for (const line of lines) {
    const m = /^-\s*\[[ xX]\]\s*(.+)$/.exec(line.trim())
    if (m) steps.push(m[1]!.trim())
  }
  return steps
}

export function parsePlanMarkdown(raw: string): ParsedPlanFile {
  const { frontmatter, body } = parseFrontmatter(raw)
  return {
    frontmatter,
    body,
    title: extractTitle(body),
    steps: extractCheckboxSteps(body)
  }
}

function listFromSection(section: string, max: number): string[] {
  const items: string[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = /^-\s+(.+)$/.exec(line.trim())
    if (m) items.push(m[1]!.trim())
    if (items.length >= max) break
  }
  return items
}

function countFileHints(body: string): number {
  const filesSection = extractSection(body, '5. 关键要素') || extractSection(body, '关键要素')
  const matches = filesSection.match(/`[^`]+`/g)
  return matches ? matches.length : 0
}

function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER_RE.test(text)
}

export function buildPlanApprovalSummary(raw: string): PlanApprovalSummary {
  const parsed = parsePlanMarkdown(raw)
  const goal = extractSection(parsed.body, '1. 目标') || extractSection(parsed.body, '目标')
  const solution =
    extractSection(parsed.body, '3. 推荐方案') || extractSection(parsed.body, '推荐方案')
  const acceptance =
    extractSection(parsed.body, '6. 验收标准') || extractSection(parsed.body, '验收标准')
  const risks = extractSection(parsed.body, '7. 风险与注意事项') || extractSection(parsed.body, '风险与注意事项')

  const placeholderWarnings: string[] = []
  if (hasPlaceholder(goal)) placeholderWarnings.push('「目标」含占位符')
  if (hasPlaceholder(solution)) placeholderWarnings.push('「推荐方案」含占位符')
  if (parsed.steps.some((s) => hasPlaceholder(s))) placeholderWarnings.push('「执行步骤」含占位符')

  const goalSummary = (solution || goal || '').split(/\r?\n/)[0]?.slice(0, 200) || '（无摘要）'

  return {
    title: parsed.title,
    goalSummary,
    stepCount: parsed.steps.length || parsed.frontmatter.steps_total || 0,
    fileHintCount: countFileHints(parsed.body),
    acceptanceCriteria: listFromSection(acceptance, 3),
    risks: listFromSection(risks, 3),
    placeholderWarnings
  }
}

export function countPlanSteps(raw: string): number {
  const parsed = parsePlanMarkdown(raw)
  if (parsed.steps.length > 0) return parsed.steps.length
  const total = parsed.frontmatter.steps_total
  return typeof total === 'number' && Number.isFinite(total) ? total : 0
}
