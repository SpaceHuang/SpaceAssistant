export type PromptText = string | ((assembly: PromptAssembly) => string)

export type PromptSection = {
  name: string
  order: number
  text: PromptText
  complete?: boolean
  template?: boolean
}

export type ContextSection = {
  name: string
  order: number
  text: PromptText
  template?: boolean
}

export type SkillFragment = {
  name: string
  contents: string
  path?: string
}

export type PromptTool = {
  name: string
  [key: string]: unknown
}

export type PromptAssembly = {
  sections: PromptSection[]
  contexts: ContextSection[]
  tools: PromptTool[]
  skillFragments?: SkillFragment[]
  variables: Record<string, string | undefined>
}

export interface TokenEstimator {
  readonly version: string
  estimateText(text: string): number
}

export type ContextPressureProjection = {
  pressureTokens: number | null
  projectedTokens: number | null
  anchorStatus: 'missing' | 'matched' | 'mismatch' | 'prefix-changed' | 'invalid'
}

export type ContextBreakdownProjection = {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export const TOOL_ORDER_REST = '<unlisted-tools>'
const SKILL_CATALOG_UPPER_BOUND = 10_000

export function buildPromptAssembly(args: {
  sections: readonly PromptSection[]
  contexts?: readonly ContextSection[]
  tools?: readonly PromptTool[]
  skillFragments?: readonly SkillFragment[]
  variables?: Record<string, string | undefined>
}): PromptAssembly {
  const names = new Set<string>()
  for (const section of args.sections) {
    if (names.has(section.name)) throw new Error(`Duplicate prompt section: ${section.name}`)
    names.add(section.name)
  }
  return { sections: [...args.sections], contexts: [...(args.contexts ?? [])], tools: orderTools(args.tools ?? []), skillFragments: [...(args.skillFragments ?? [])], variables: { ...(args.variables ?? {}) } }
}

function resolveText(text: PromptText, assembly: PromptAssembly): string {
  return typeof text === 'function' ? text(assembly) : text
}

function renderVariables(text: string, variables: Record<string, string | undefined>): string {
  return text.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, name: string) => {
    if (!(name in variables) || variables[name] === undefined) {
      throw new Error(`Unknown variable: ${name}`)
    }
    return variables[name]!
  })
}

export function renderPrompt(assembly: PromptAssembly): string {
  const complete = assembly.sections.filter((section) => section.complete)
  if (complete.length > 1) throw new Error('Multiple complete prompt sections are not allowed')
  const sections = complete.length > 0 ? complete : assembly.sections
  return sections
    .slice()
    .sort((a, b) => {
      const order = a.order - b.order
      return order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    })
    .map((section) => (section.template ? renderVariables(resolveText(section.text, assembly), assembly.variables) : resolveText(section.text, assembly)).trim())
    .filter(Boolean)
    .join('\n\n')
}

export function renderContextSections(assembly: PromptAssembly): string {
  return assembly.contexts
    .slice()
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((section) => (section.template ? renderVariables(resolveText(section.text, assembly), assembly.variables) : resolveText(section.text, assembly)).trim())
    .filter(Boolean)
    .join('\n\n')
}

export function renderContextSnapshot(assembly: PromptAssembly): string {
  const body = renderContextSections(assembly)
  return body ? `This snapshot supersedes earlier runtime-context snapshots.\n\n${body}` : ''
}

export function renderSkillFragments(assembly: PromptAssembly): string[] {
  return (assembly.skillFragments ?? [])
    .filter((fragment) => fragment.contents.trim())
    .map((fragment) => {
      const path = fragment.path ? ` path="${fragment.path}"` : ''
      return `<skill name="${fragment.name}"${path}>\n${fragment.contents.trim()}\n</skill>`
    })
}

export function orderTools<T extends PromptTool>(tools: readonly T[], knownNames?: readonly string[]): T[] {
  if (knownNames?.includes(TOOL_ORDER_REST)) throw new Error(`${TOOL_ORDER_REST} is reserved`)
  const rank = new Map((knownNames ?? []).map((name, index) => [name, index]))
  return [...tools].sort((a, b) => {
    const ar = rank.has(a.name) ? rank.get(a.name)! : Number.MAX_SAFE_INTEGER
    const br = rank.has(b.name) ? rank.get(b.name)! : Number.MAX_SAFE_INTEGER
    return ar - br || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
}

export function skillCatalogBudget(contextWindow: number, maxSkillTokens = SKILL_CATALOG_UPPER_BOUND): number {
  return Math.max(0, Math.min(SKILL_CATALOG_UPPER_BOUND, maxSkillTokens, Math.floor(contextWindow * 0.02)))
}
