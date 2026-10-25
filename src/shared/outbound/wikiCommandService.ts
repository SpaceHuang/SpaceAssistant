import type { SessionSkillsState, WikiStatus } from '../domainTypes'
import { normalizeSessionSkillsState } from '../domainTypes'
import { resolveWikiAbsolutePathLink } from '../markdownLinkResolve'
import { WIKI_VOCABULARY_PREFIX } from '../wikiConstants'

export type WikiCommandResult =
  | { type: 'chat'; text: string }
  | { type: 'command'; hint: string; skillsState?: SessionSkillsState }
  | { type: 'run'; text: string; hint: string; skillsState: SessionSkillsState; wikiModeActive: true }

export type WikiCommandDeps = {
  wikiInit: (payload?: {
    overwrite?: boolean
    installSkill?: boolean
  }) => Promise<{ ok: true; rootPath: string; skillInstalled: boolean } | { ok: false; error: string }>
  wikiStatus: () => Promise<WikiStatus>
  wikiImportRaw: (payload: {
    srcRelPath: string
  }) => Promise<{ ok: true; rawRelPath: string; copied: boolean; sourceId?: string; sourceRevision?: number } | { ok: false; error: string }>
  wikiImportAllRaw?: () => Promise<{ ok: true; sources: Array<{ sourceId: string; sourceRevision: number; displayName: string }>; remainingCount?: number } | { ok: false; error: string }>
}

const WIKI_SKILL = WIKI_VOCABULARY_PREFIX
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
  sessionSkillsState: SessionSkillsState,
  deps: WikiCommandDeps
): Promise<WikiCommandResult> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/wiki')) return { type: 'chat', text }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = normalizeWikiSubcommand(parts[1])

  if (!sub || sub === 'help') {
    return {
      type: 'command',
      hint:
        '[Wiki] 命令：/wiki init | status | ingest|摄取|提取 <workDir内路径> | ingest --all | query <问题> | lint [--fix] | <问题>'
    }
  }

  if (sub === 'init') {
    const result = await deps.wikiInit({ installSkill: true })
    if (!result.ok) return { type: 'command', hint: `[Wiki] 初始化失败: ${result.error}` }
    return {
      type: 'command',
      hint: `[Wiki] 已初始化 Wiki（${result.rootPath}）${result.skillInstalled ? `，已安装 ${WIKI_SKILL} Skill` : ''}`
    }
  }

  if (sub === 'status') {
    const status = await deps.wikiStatus()
    return { type: 'command', hint: formatStatus(status) }
  }

  const status = await deps.wikiStatus()
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
      if (!deps.wikiImportAllRaw) return { type: 'command', hint: '[Wiki] 批量来源导入不可用，请升级应用后重试' }
      const imported = await deps.wikiImportAllRaw()
      if (!imported.ok) return { type: 'command', hint: `[Wiki] 批量来源导入失败: ${imported.error}` }
      if (!imported.sources.length) return { type: 'command', hint: '[Wiki] 当前工作目录没有可导入的文本来源' }
      return {
        type: 'run',
        text: `请通过 memory.wiki_read_source 读取并整理以下已绑定来源，再通过 memory.wiki_save_page 保存知识页面。\n${imported.sources.map(source => `- sourceId=${source.sourceId} sourceRevision=${source.sourceRevision} displayName=${source.displayName}`).join('\n')}`,
        hint: `[Wiki] 已绑定 ${imported.sources.length} 个知识来源${imported.remainingCount ? `，还有 ${imported.remainingCount} 个待后续批次导入` : ''}，Ingest 已开始`,
        skillsState,
        wikiModeActive: true
      }
    }

    const importResult = await deps.wikiImportRaw({ srcRelPath: target })
    if (!importResult.ok) {
      return { type: 'command', hint: `[Wiki] ${importResult.error}` }
    }
    if (!importResult.sourceId || !importResult.sourceRevision) return { type: 'command', hint: '[Wiki] 来源绑定未完成，无法启动领域 Ingest；请检查 Wiki 服务状态后重试' }

    const sourceId = importResult.sourceId
    return {
      type: 'run',
      text: `请通过 memory.wiki_read_source 读取并整理来源 sourceId=${sourceId}，再通过 memory.wiki_save_page 保存知识页面。来源版本为 ${importResult.sourceRevision}。`,
      hint: importResult.copied
        ? `[Wiki] 已绑定知识来源，Ingest 已开始：${sourceId}`
        : `[Wiki] 已绑定现有知识来源，Ingest 已开始：${sourceId}`,
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

export function isWikiPathLink(href: string, wikiRootPath = WIKI_VOCABULARY_PREFIX): string | null {
  return resolveWikiAbsolutePathLink(href, wikiRootPath)
}
