import type { WorkDirProfile } from '../../src/shared/feishuTypes'

const PROJECT_HINT_RE = /(?:在|针对|项目[:：]?)\s*[「"']?([^「"'\n]+)[」"']?\s*(?:项目|仓库|里|中)/

export interface WorkDirResolveResult {
  profile: WorkDirProfile | null
  ambiguous?: WorkDirProfile[]
  strippedContent?: string
}

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

export function resolveWorkDirFromFeishuCommand(
  content: string,
  profiles: WorkDirProfile[],
  activeProfileId?: string
): WorkDirResolveResult {
  if (profiles.length === 0) return { profile: null, strippedContent: content }

  const prefixMatch = content.match(/^\/sa\s+@([^\s]+)\s+([\s\S]*)$/i)
  if (prefixMatch) {
    const hint = prefixMatch[1]
    const rest = prefixMatch[2].trim()
    const found = matchProfile(hint, profiles)
    if (found.length === 1) return { profile: found[0], strippedContent: rest }
    if (found.length > 1) return { profile: null, ambiguous: found, strippedContent: rest }
  }

  const hintMatch = content.match(PROJECT_HINT_RE)
  if (hintMatch) {
    const found = matchProfile(hintMatch[1], profiles)
    if (found.length === 1) return { profile: found[0], strippedContent: content }
    if (found.length > 1) return { profile: null, ambiguous: found, strippedContent: content }
  }

  const defaultProfile =
    profiles.find((p) => p.id === activeProfileId) ?? profiles.find((p) => p.isDefault) ?? profiles[0]
  return { profile: defaultProfile ?? null, strippedContent: content }
}

function matchProfile(hint: string, profiles: WorkDirProfile[]): WorkDirProfile[] {
  const n = normalize(hint)
  return profiles.filter((p) => {
    if (normalize(p.name) === n) return true
    if (normalize(p.name).includes(n) || n.includes(normalize(p.name))) return true
    return (p.aliases ?? []).some((a) => normalize(a) === n || normalize(a).includes(n))
  })
}

export function buildDisambiguationReply(profiles: WorkDirProfile[]): string {
  const lines = profiles.map((p, i) => `${i + 1}) ${p.name}`).join('  ')
  return `检测到多个匹配项目：${lines}\n请回复数字选择，或下次使用：/sa @项目名 你的指令`
}

export function resolveDisambiguationChoice(text: string, profiles: WorkDirProfile[]): WorkDirProfile | null {
  const n = parseInt(text.trim(), 10)
  if (!Number.isFinite(n) || n < 1 || n > profiles.length) return null
  return profiles[n - 1] ?? null
}
