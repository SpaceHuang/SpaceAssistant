import fs from 'fs'
import path from 'path'
import type { WikiConfig, WikiStatus } from '../../src/shared/domainTypes'
import { isWikiInitialized } from './wikiInit'
import { resolveWikiRootAbs } from './wikiPaths'

function countMarkdownFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let count = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile() && ent.name.endsWith('.md')) count++
    }
  }
  return count
}

function countRawFiles(rawDir: string): number {
  if (!fs.existsSync(rawDir)) return 0
  return fs.readdirSync(rawDir).filter((n) => {
    const p = path.join(rawDir, n)
    return fs.statSync(p).isFile()
  }).length
}

function readLastLogEntry(logPath: string): string | undefined {
  if (!fs.existsSync(logPath)) return undefined
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('## [')) return line
  }
  return undefined
}

export function getWikiStatus(workDir: string, wikiConfig: WikiConfig): WikiStatus {
  const rootRel = wikiConfig.rootPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const initialized = isWikiInitialized(workDir, wikiConfig)
  if (!initialized) {
    return {
      enabled: wikiConfig.enabled,
      rootPath: rootRel,
      initialized: false,
      pageCount: 0,
      rawCount: 0
    }
  }

  const root = resolveWikiRootAbs(workDir, wikiConfig)
  const wikiDir = path.join(root, 'wiki')
  const rawDir = path.join(root, 'raw')
  const logPath = path.join(wikiDir, 'log.md')

  return {
    enabled: wikiConfig.enabled,
    rootPath: rootRel,
    initialized: true,
    pageCount: countMarkdownFiles(wikiDir),
    rawCount: countRawFiles(rawDir),
    lastLogEntry: readLastLogEntry(logPath)
  }
}
