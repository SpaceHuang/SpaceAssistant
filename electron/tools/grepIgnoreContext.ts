import { createHash } from 'node:crypto'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

export async function grepIgnoreContextDigest(workDirInput: string, rootInput: string): Promise<string | undefined> {
  const workDir = path.resolve(workDirInput)
  const root = path.resolve(rootInput)
  const relative = path.relative(workDir, root)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined
  const ancestors: string[] = []
  for (let current = workDir;; current = path.dirname(current)) {
    ancestors.unshift(current)
    if (path.dirname(current) === current) break
  }
  const directories = ancestors
  if (relative && relative !== '.') {
    let current = workDir
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      directories.push(current)
    }
  }
  const records: Array<readonly [string, string | null]> = []
  const seenGitConfigs = new Set<string>()
  const seenFiles = new Set<string>()
  const readBoundedConfig = async (filePath: string, key: string, asGitConfig = false, depth = 0): Promise<boolean> => {
    try {
      if (depth > 8 || seenGitConfigs.has(filePath)) return false
      if (seenFiles.has(filePath)) return true
      const stat = await fsPromises.lstat(filePath)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) return false
      const body = await fsPromises.readFile(filePath)
      seenFiles.add(filePath)
      const text = body.toString('utf8')
      if (asGitConfig) {
        seenGitConfigs.add(filePath)
        let section = ''
        let excludesFile: string | undefined
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed)
          if (sectionMatch) {
            section = sectionMatch[1]!.split(/\s+/)[0]!.replaceAll('"', '').toLowerCase()
            if (section === 'include' || section === 'includeif') return false
            continue
          }
          if (section !== 'core') continue
          const setting = /^excludesfile\s*=\s*(.*?)\s*$/i.exec(trimmed.replace(/\s[;#].*$/, ''))
          if (setting) { excludesFile = setting[1]!.replace(/^"|"$/g, ''); break }
        }
        if (excludesFile) {
          const homeDir = process.env.HOME ?? process.env.USERPROFILE
          const expanded = excludesFile === '~' ? homeDir : excludesFile.startsWith('~/') && homeDir
            ? path.join(homeDir, excludesFile.slice(2)) : excludesFile
          if (!expanded || !path.isAbsolute(expanded)) return false
          if (!await readBoundedConfig(expanded, `git-excludes:${expanded}`, false, depth + 1)) return false
        }
      }
      records.push([key, createHash('sha256').update(body).digest('hex')])
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }
  for (const directory of directories) {
    try {
      const stat = await fsPromises.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
    } catch { return undefined }
    const prefix = path.relative(workDir, directory) || '.'
    for (const name of ['.gitignore', '.ignore', '.rgignore']) {
      if (!await readBoundedConfig(path.join(directory, name), `${prefix}/${name}`)) return undefined
    }
  }
  // Snapshot descendant ignore files too: a child .gitignore can change which files
  // an inherited parent query would reach. Bound traversal; an incomplete snapshot disables reuse.
  let visitedEntries = 0
  const walkIgnoreFiles = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > 64) return false
    let handle: Awaited<ReturnType<typeof fsPromises.opendir>>
    try { handle = await fsPromises.opendir(directory) } catch { return false }
    try {
      for await (const entry of handle) {
        if (++visitedEntries > 100_000) return false
        const fullPath = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          if (['.gitignore', '.ignore', '.rgignore'].includes(entry.name)) return false
          continue
        }
        if (entry.name === '.git') {
          if (fullPath !== path.join(workDir, '.git')) return false
          continue
        }
        if (entry.isDirectory()) {
          if (!await walkIgnoreFiles(fullPath, depth + 1)) return false
        } else if (entry.isFile() && ['.gitignore', '.ignore', '.rgignore'].includes(entry.name)) {
          const key = path.relative(workDir, fullPath).split(path.sep).join('/')
          if (!await readBoundedConfig(fullPath, key)) return false
        }
      }
      return true
    } catch { return false }
  }
  if (!await walkIgnoreFiles(root, 0)) return undefined
  const home = process.env.HOME ?? process.env.USERPROFILE
  const xdg = process.env.XDG_CONFIG_HOME ?? (home ? path.join(home, '.config') : undefined)
  const configFiles = [process.env.GIT_CONFIG_SYSTEM, process.env.GIT_CONFIG_GLOBAL,
    '/etc/gitconfig', home ? path.join(home, '.gitconfig') : undefined, xdg ? path.join(xdg, 'git', 'config') : undefined]
  for (const filePath of [...new Set(configFiles.filter((value): value is string => Boolean(value)))]) {
    if (!await readBoundedConfig(filePath, `git-config:${filePath}`, true)) return undefined
  }
  const ripgrepConfig = process.env.RIPGREP_CONFIG_PATH
  if (ripgrepConfig) {
    if (!path.isAbsolute(ripgrepConfig) || !await readBoundedConfig(ripgrepConfig, 'ripgrep-config')) return undefined
  }
  if (xdg && !await readBoundedConfig(path.join(xdg, 'git', 'ignore'), 'git-global-ignore')) return undefined
  let cursor = workDir
  let gitDir: string | undefined
  for (;;) {
    const marker = path.join(cursor, '.git')
    try {
      const stat = await fsPromises.lstat(marker)
      if (stat.isSymbolicLink()) return undefined
      if (stat.isDirectory()) gitDir = marker
      else if (stat.isFile()) {
        const content = (await fsPromises.readFile(marker, 'utf8')).trim()
        const match = /^gitdir:\s*(.+)$/i.exec(content)
        if (!match) return undefined
        gitDir = path.resolve(cursor, match[1]!)
      } else return undefined
      if (gitDir) break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (gitDir) {
    if (!await readBoundedConfig(path.join(gitDir, 'config'), `git-repo-config:${gitDir}`, true)) return undefined
    if (!await readBoundedConfig(path.join(gitDir, 'info', 'exclude'), 'git-info-exclude')) return undefined
  }
  const gitConfigEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key === 'GIT_CONFIG_COUNT' || key === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
  ).sort(([left], [right]) => left.localeCompare(right)))
  records.push(['environment', JSON.stringify({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    RIPGREP_CONFIG_PATH: ripgrepConfig, gitConfigEnvironment })])
  records.sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(records)).digest('hex')
}
