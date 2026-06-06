import fs from 'fs/promises'
import path from 'path'
import { resolveSafePath, resolveSafePathReal } from '../pathSecurity'
import { isSensitivePath } from './shellSensitivePaths'
import type { ShellPathLiteral, ShellPathVerdict } from './shellTypes'

const READ_CMDS = new Set(['cat', 'type', 'more', 'head', 'tail', 'less', 'dir', 'copy', 'xcopy'])
const PATH_FLAGS = new Set(['-f', '--file', '-o', '--output', '--git-dir'])

/** Normalize Windows path tokens: strip \\?\ prefix, unify separators. */
export function normalizeWindowsPath(token: string): string {
  let s = token
  if (s.startsWith('\\\\?\\')) {
    s = s.slice(4)
  }
  if (s.startsWith('//?/')) {
    s = s.slice(4)
  }
  return s.replace(/\\/g, '/')
}

function looksLikePath(token: string): boolean {
  if (!token || token.startsWith('-')) return false
  const normalized = normalizeWindowsPath(token)
  if (
    normalized.includes('/') ||
    token.includes(path.sep) ||
    normalized.startsWith('.') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /^[a-zA-Z]:[/\\]/.test(token) ||
    normalized.startsWith('//') ||
    normalized.startsWith('/')
  ) {
    return true
  }
  return false
}

export function extractPathLiterals(segment: string, segmentIndex: number): ShellPathLiteral[] {
  const tokens = tokenizeSegment(segment)
  if (tokens.length === 0) return []

  const out: ShellPathLiteral[] = []
  const cmd = tokens[0]!.toLowerCase()

  if (tokens[0]?.toLowerCase() === 'cd') {
    if (tokens[1]?.toLowerCase() === '/d' && tokens[2]) {
      out.push({ raw: tokens[2], segmentIndex, kind: 'cd-target' })
    } else if (tokens[1]) {
      out.push({ raw: tokens[1], segmentIndex, kind: 'cd-target' })
    }
    return out
  }

  if (READ_CMDS.has(cmd) && tokens[1] && looksLikePath(tokens[1])) {
    out.push({ raw: tokens[1], segmentIndex, kind: 'arg' })
  }

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    const prev = tokens[i - 1]
    if (prev && PATH_FLAGS.has(prev) && looksLikePath(t)) {
      out.push({ raw: t, segmentIndex, kind: 'flag-value' })
    } else if (looksLikePath(t) && !t.startsWith('-')) {
      out.push({ raw: t, segmentIndex, kind: 'arg' })
    }
  }
  return out
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) tokens.push(cur)
  return tokens
}

function isOutsideWorkDir(workDir: string, resolved: string): boolean {
  const base = path.resolve(workDir)
  const rel = path.relative(base, path.resolve(resolved))
  return rel.startsWith('..') || path.isAbsolute(rel)
}

export function detectOutsideWorkDirRisk(segment: string): boolean {
  const t = segment.trim().toLowerCase()
  if (/^npm\s+run\s+/.test(t) && !/^npm\s+run\s+install\b/.test(t)) return true
  if (/^(pnpm|yarn)\s+/.test(t) && !/\binstall\b/.test(t)) return true
  if (/^npx\s+/.test(t) && !/\binstall\b/.test(t)) return true
  return false
}

export async function verifyPathsInWorkDir(
  workDir: string,
  literals: ShellPathLiteral[],
  userDataDir?: string,
  customSensitivePrefixes?: string[]
): Promise<ShellPathVerdict> {
  const violations: ShellPathVerdict['violations'] = []
  const warnings: string[] = []
  const violationCodes: string[] = []
  let requiresRiskAck = false
  let outsideWorkDirRisk = false

  for (const lit of literals) {
    let resolved: string
    const pathToken = normalizeWindowsPath(lit.raw)
    try {
      if (path.isAbsolute(pathToken) || path.isAbsolute(lit.raw)) {
        resolved = path.resolve(pathToken.startsWith('//') && !pathToken.startsWith('//?') ? lit.raw : pathToken)
      } else {
        resolved = resolveSafePath(workDir, pathToken)
      }
      lit.resolved = resolved
    } catch {
      const isCd = lit.kind === 'cd-target'
      violations.push({
        code: isCd ? 'CD_OUTSIDE_WORKDIR' : 'PATH_OUTSIDE_WORKDIR',
        message: isCd
          ? `cd 目标不在工作目录内：${lit.raw}`
          : `命令包含工作目录外的路径：${lit.raw}`,
        path: lit.raw,
        severity: 'warning'
      })
      violationCodes.push(isCd ? 'CD_OUTSIDE_WORKDIR' : 'PATH_OUTSIDE_WORKDIR')
      requiresRiskAck = true
      continue
    }

    if (isOutsideWorkDir(workDir, resolved)) {
      violations.push({
        code: 'PATH_OUTSIDE_WORKDIR',
        message: `命令包含工作目录外的路径：${lit.raw}`,
        path: lit.raw,
        severity: 'warning'
      })
      violationCodes.push('PATH_OUTSIDE_WORKDIR')
      requiresRiskAck = true
    }

    if (lit.kind === 'cd-target' && isOutsideWorkDir(workDir, resolved)) {
      violations.push({
        code: 'CD_OUTSIDE_WORKDIR',
        message: `cd 目标不在工作目录内：${lit.raw}`,
        path: lit.raw,
        severity: 'warning'
      })
      violationCodes.push('CD_OUTSIDE_WORKDIR')
      requiresRiskAck = true
    }

    if (isSensitivePath(resolved, userDataDir, customSensitivePrefixes)) {
      violations.push({
        code: 'SENSITIVE_PATH',
        message: `命令涉及敏感路径：${lit.raw}（如密钥、凭据目录）`,
        path: lit.raw,
        severity: 'warning'
      })
      violationCodes.push('SENSITIVE_PATH')
      requiresRiskAck = true
    }

    if (!path.isAbsolute(lit.raw)) {
      try {
        const real = await resolveSafePathReal(workDir, lit.raw)
        if (isOutsideWorkDir(workDir, real)) {
          violations.push({
            code: 'SYMLINK_OUTSIDE',
            message: `符号链接解析后指向工作目录外：${lit.raw}`,
            path: lit.raw,
            severity: 'warning'
          })
          violationCodes.push('SYMLINK_OUTSIDE')
          requiresRiskAck = true
        }
      } catch {
        /* path may not exist yet */
      }
    }
  }

  for (const w of violations) {
    if (!warnings.includes(w.message)) warnings.push(w.message)
  }

  return {
    decision: 'ask',
    violations,
    warnings,
    outsideWorkDirRisk,
    requiresRiskAck
  }
}

export async function analyzeSegmentPaths(
  workDir: string,
  segments: string[],
  userDataDir?: string,
  customSensitivePrefixes?: string[]
): Promise<{ literals: ShellPathLiteral[]; pathVerdict: ShellPathVerdict }> {
  const literals: ShellPathLiteral[] = []
  for (let i = 0; i < segments.length; i++) {
    literals.push(...extractPathLiterals(segments[i]!, i))
    if (detectOutsideWorkDirRisk(segments[i]!)) {
      /* handled below */
    }
  }

  const pathVerdict = await verifyPathsInWorkDir(workDir, literals, userDataDir, customSensitivePrefixes)

  for (const seg of segments) {
    if (detectOutsideWorkDirRisk(seg)) {
      pathVerdict.outsideWorkDirRisk = true
      pathVerdict.requiresRiskAck = true
      const msg = '此命令可能访问工作目录外的文件；Shell 不是文件沙箱'
      if (!pathVerdict.warnings.includes(msg)) pathVerdict.warnings.push(msg)
      if (!pathVerdict.violations.some((v) => v.code === 'OUTSIDE_WORKDIR_RISK')) {
        pathVerdict.violations.push({ code: 'OUTSIDE_WORKDIR_RISK', message: msg, severity: 'warning' })
      }
    }
  }

  return { literals, pathVerdict }
}
