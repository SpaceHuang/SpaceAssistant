// P3-T3：PowerShell 结构性危险模式（树事实驱动，结构匹配）。
import os from 'node:os'
import path from 'node:path'
import type { PsCommandFacts } from './powershellCommandFacts'
import { isSensitivePath } from './shellSensitivePaths'
import { normalizeWindowsPath } from './shellPathAnalysis'

export interface PsPatternHit {
  id: string
  verdict: 'ask' | 'deny'
  reason: string
}

const IEX_NAMES = new Set(['iex', 'invoke-expression'])
const DOWNLOAD_MARKERS = ['downloadstring', 'downloadfile', 'invoke-webrequest', 'invoke-restmethod', 'curl']
const DESTRUCTIVE_CMLETS = new Set(['format-volume', 'clear-disk', 'remove-item', 'rd', 'del', 'erase'])
const PS_HOSTS = new Set(['powershell', 'pwsh', 'powershell.exe', 'pwsh.exe'])
const ENCODED_FLAGS = new Set(['-encodedcommand', '-enc', '-e'])

function expandHomeTilde(target: string): string {
  if (target.startsWith('~/') || target === '~') return path.join(os.homedir(), target.slice(1))
  return target
}

export function matchPsDangerousPatterns(
  facts: PsCommandFacts,
  userDataDir?: string,
  customSensitivePrefixes?: string[],
  platform: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix'
): PsPatternHit | null {
  const hits: PsPatternHit[] = []

  for (const cmd of facts.commands) {
    const verb = cmd.name.toLowerCase()
    const argsLower = cmd.args.map((a) => a.toLowerCase())

    // 1) ps-iex-cradle：iex/Invoke-Expression 包裹下载调用（结构匹配：参数文本含下载方法）
    if (IEX_NAMES.has(verb)) {
      const joined = cmd.args.join(' ').toLowerCase()
      if (DOWNLOAD_MARKERS.some((m) => joined.includes(m))) {
        hits.push({ id: 'ps-iex-cradle', verdict: 'deny', reason: 'IEX 包裹远程下载执行（IEX cradle），已拒绝' })
      }
    }

    // 2) ps-encoded-command：powershell/pwsh -EncodedCommand（隐藏 payload）
    if (PS_HOSTS.has(verb) && argsLower.some((a) => ENCODED_FLAGS.has(a))) {
      hits.push({ id: 'ps-encoded-command', verdict: 'ask', reason: 'powershell -EncodedCommand 隐藏载荷，需人工确认' })
    }

    // 3) ps-destructive：破坏性 cmdlet（Remove-Item 递归强删根/用户根；Format-Volume/Clear-Disk）
    if (DESTRUCTIVE_CMLETS.has(verb)) {
      if (verb === 'remove-item' || verb === 'rd' || verb === 'del' || verb === 'erase') {
        const recursive = argsLower.some((a) => a === '-recurse' || a === '-r')
        const force = argsLower.some((a) => a === '-force' || a === '-f')
        if (recursive) {
          const targets = cmd.args.filter((a) => !a.startsWith('-') && !argsLower.slice(0, cmd.args.indexOf(a)).join(' ').endsWith(a))
          for (const t of targets) {
            const norm = normalizeWindowsPath(t).toLowerCase()
            const isRoot = /^[a-z]:\/?$/.test(norm) || norm === '/' || norm === '~' || norm === '$home' || norm === '\\'
            if (isRoot || (force && norm.startsWith('c:/'))) {
              hits.push({ id: 'ps-destructive', verdict: 'deny', reason: `Remove-Item 递归删除根/家目录目标（${t}），已拒绝` })
              break
            }
          }
        }
      } else {
        hits.push({ id: 'ps-destructive', verdict: 'deny', reason: `破坏性卷/磁盘操作（${cmd.name}），已拒绝` })
      }
    }

    // 4) ps-redirect-sensitive：重定向目标落敏感路径
    for (const r of cmd.redirects) {
      if (!r.target) continue
      const expanded = expandHomeTilde(r.target)
      if (isSensitivePath(normalizeWindowsPath(expanded), userDataDir, customSensitivePrefixes, platform)) {
        hits.push({ id: 'ps-redirect-sensitive', verdict: 'ask', reason: `重定向目标为敏感路径（${r.target}），需人工确认` })
      }
    }
  }

  if (hits.length === 0) return null
  return hits.find((h) => h.verdict === 'deny') ?? hits[0]!
}
