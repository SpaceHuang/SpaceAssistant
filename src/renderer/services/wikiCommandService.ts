import type { SessionSkillsState, WikiConfig, WikiStatus } from '../../shared/domainTypes'
import { normalizeSessionSkillsState } from '../../shared/domainTypes'

export type WikiCommandResult =
  | { type: 'chat'; text: string }
  | { type: 'command'; hint: string; skillsState?: SessionSkillsState }
  | { type: 'run'; text: string; hint: string; skillsState: SessionSkillsState; wikiModeActive: true }

const WIKI_SKILL = 'llm-wiki'
const INGEST_ALIASES = new Set(['ingest', '摄取', '提取'])

function normalizeWikiSubcommand(sub: string | undefined): string | undefined {
  if (!sub) return sub
  if (INGEST_ALIASES.has(sub)) return 'ingest'
  return sub.toLowerCase()
}

function activateWikiSkill(state: SessionSkillsState): SessionSkillsState {
  const base = normalizeSessionSkillsState(state)
  const manualActivated = [...new Set([...base.manualActivated, WIKI_SKILL])]
  const manualDisabled = base.manualDisabled.filter((n) => n !== WIKI_SKILL)
  return { manualActivated, manualDisabled }
}

function formatStatus(status: WikiStatus): string {
  const lines = [
    `[Wiki] 根路径: ${status.rootPath}`,
    `[Wiki] 已初始化: ${status.initialized ? '是' : '否'}`,
    `[Wiki] Wiki 页数: ${status.pageCount}`,
    `[Wiki] raw 文件数: ${status.rawCount}`
  ]
  if (status.lastLogEntry) lines.push(`[Wiki] 最近日志: ${status.lastLogEntry}`)
  return lines.join('\n')
}

export async function parseWikiCommand(
  text: string,
  wikiConfig: WikiConfig,
  sessionSkillsState: SessionSkillsState
): Promise<WikiCommandResult> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/wiki')) return { type: 'chat', text }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = normalizeWikiSubcommand(parts[1])

  if (!wikiConfig.enabled && sub !== 'help') {
    return { type: 'command', hint: '[Wiki] Wiki 功能未启用，请先在设置中开启' }
  }

  if (!sub || sub === 'help') {
    return {
      type: 'command',
      hint:
        '[Wiki] 命令：/wiki init | status | ingest|摄取|提取 <workDir内路径> | ingest --all | query <问题> | lint [--fix] | <问题>'
    }
  }

  if (sub === 'init') {
    const result = await window.api.wikiInit({ installSkill: true })
    if (!result.ok) return { type: 'command', hint: `[Wiki] 初始化失败: ${result.error}` }
    return {
      type: 'command',
      hint: `[Wiki] 已初始化 Wiki（${result.rootPath}）${result.skillInstalled ? '，已安装 llm-wiki Skill' : ''}`
    }
  }

  if (sub === 'status') {
    const status = await window.api.wikiStatus()
    return { type: 'command', hint: formatStatus(status) }
  }

  const status = await window.api.wikiStatus()
  if (!status.initialized) {
    return { type: 'command', hint: '[Wiki] Wiki 尚未初始化，请先执行 /wiki init 或在设置中初始化' }
  }

  const skillsState = activateWikiSkill(sessionSkillsState)

  if (sub === 'ingest') {
    const target = parts[2]
    if (!target) {
      return { type: 'command', hint: '[Wiki] 用法: /wiki ingest|摄取|提取 <workDir内路径> 或 /wiki ingest --all' }
    }
    if (target === '--all') {
      return {
        type: 'run',
        text: '请对 raw/ 下尚未 ingest 的文件执行 Wiki Ingest 工作流（批量上限见配置）。',
        hint: '[Wiki] Ingest 已开始：--all',
        skillsState,
        wikiModeActive: true
      }
    }

    const importResult = await window.api.wikiImportRaw({ srcRelPath: target })
    if (!importResult.ok) {
      return { type: 'command', hint: `[Wiki] ${importResult.error}` }
    }

    const rawPath = importResult.rawRelPath
    return {
      type: 'run',
      text: `请对 raw 文件「${rawPath}」执行 Wiki Ingest 工作流。`,
      hint: importResult.copied
        ? `[Wiki] 已导入 raw：${rawPath}，Ingest 已开始`
        : `[Wiki] Ingest 已开始：${rawPath}`,
      skillsState,
      wikiModeActive: true
    }
  }

  if (sub === 'lint') {
    const fix = parts.includes('--fix')
    return {
      type: 'run',
      text: fix ? '请执行 Wiki Lint 健康检查，并在确认后修复可自动修复的问题。' : '请执行 Wiki Lint 健康检查。',
      hint: `[Wiki] Lint 已开始${fix ? '（含 --fix）' : ''}`,
      skillsState,
      wikiModeActive: true
    }
  }

  if (sub === 'query') {
    const question = parts.slice(2).join(' ').trim()
    if (!question) return { type: 'command', hint: '[Wiki] 用法: /wiki query <问题>' }
    return {
      type: 'run',
      text: question,
      hint: '[Wiki] 已进入 Wiki Query 模式',
      skillsState,
      wikiModeActive: true
    }
  }

  const question = parts.slice(1).join(' ').trim()
  return {
    type: 'run',
    text: question,
    hint: '[Wiki] 已进入 Wiki Query 模式',
    skillsState,
    wikiModeActive: true
  }
}

export function isWikiPathLink(href: string, wikiRootPath = 'llm-wiki'): string | null {
  if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) return null
  const normalized = href.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.startsWith(`${wikiRootPath}/`) || normalized.startsWith('wiki/')) {
    return normalized.startsWith('wiki/') ? `${wikiRootPath}/${normalized}` : normalized
  }
  return null
}
