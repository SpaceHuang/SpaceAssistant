import path from 'path'
import fs from 'fs/promises'
import { resolveSafePathReal } from '../pathSecurity'
import type { FileStateCache } from '../fileStateCache'
import type { AppDatabase } from '../database'
import {
  findLatestWriteDirChoiceInWorkspace,
  resolveWorkspaceProfileIds
} from './sessionWriteDir'
import type { WriteDirCandidateLabelKind } from '../../src/shared/api'

export interface WriteDirCandidate {
  key: string
  dir: string
  label: string
  labelKind?: WriteDirCandidateLabelKind
}

export interface CollectArgs {
  workDir: string
  sessionId: string
  fileStateCache: FileStateCache
  userMessages: string[]
  db?: AppDatabase
}

const MAX_CANDIDATES = 25

/** 从用户消息文本中提取形似路径的片段 */
function extractPathLikeFragments(text: string): string[] {
  const out: string[] = []
  const re = /(?:[A-Za-z]:[\\/][^\s'"<>|*?]+)|(?:\.?\.?[\\/][^\s'"<>|*?]+)|(?:[\w-]+(?:[\\/][\w.-]+)+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(m[0])
  }
  const dirHint = text.match(/(?:^|[\s，,])([\w.-]+)\s*目录/g)
  if (dirHint) {
    for (const raw of dirHint) {
      const name = raw.replace(/目录.*$/, '').trim().split(/\s+/).pop()
      if (name) out.push(name)
    }
  }
  const tokens = text.match(/[\w./\\-]+/g) ?? []
  for (const token of tokens) {
    if (token.length >= 2 && !out.includes(token)) out.push(token)
  }
  return out
}

export async function collectWriteDirCandidates(args: CollectArgs): Promise<WriteDirCandidate[]> {
  const { workDir, fileStateCache, userMessages, sessionId, db } = args
  const seen = new Set<string>()
  const dirs: string[] = []
  const dirLabelKinds = new Map<string, WriteDirCandidateLabelKind>()

  const add = (absDir: string, labelKind?: WriteDirCandidateLabelKind) => {
    const norm = path.resolve(absDir)
    if (seen.has(norm)) {
      if (labelKind) dirLabelKinds.set(norm, labelKind)
      return
    }
    seen.add(norm)
    dirs.push(norm)
    if (labelKind) dirLabelKinds.set(norm, labelKind)
  }

  if (db) {
    const { workDirProfileId, activeProfileId } = resolveWorkspaceProfileIds(db, sessionId)
    if (workDirProfileId) {
      const latest = findLatestWriteDirChoiceInWorkspace(db, {
        workDirProfileId,
        activeProfileId,
        excludeSessionId: sessionId,
        workDir
      })
      if (latest) {
        add(latest.dir, 'recentSession')
      }
    }
  }

  for (const absFile of fileStateCache.keys()) {
    add(path.dirname(absFile))
  }

  for (const msg of userMessages) {
    for (const frag of extractPathLikeFragments(msg)) {
      try {
        const resolved = await resolveSafePathReal(workDir, frag)
        const st = await fs.stat(resolved)
        if (st.isDirectory()) add(resolved)
      } catch {
        // 非有效目录，跳过
      }
    }
  }

  add(path.resolve(workDir))

  const limited = dirs.slice(0, MAX_CANDIDATES)
  return limited.map((dir, i) => ({
    key: String.fromCharCode('A'.charCodeAt(0) + i),
    dir,
    label: path.relative(workDir, dir) || '.',
    ...(dirLabelKinds.has(dir) ? { labelKind: dirLabelKinds.get(dir) } : {})
  }))
}
