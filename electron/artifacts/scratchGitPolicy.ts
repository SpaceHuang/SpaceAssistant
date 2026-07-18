/** Whether .gitignore contains an exact, portable rule for generated scratch runs. */
export function isScratchRunsIgnored(gitignoreContents: string): boolean {
  return gitignoreContents.split(/\r?\n/).some((line) => {
    const rule = line.trim()
    return rule === '.spaceassistant/runs/' || rule === '/.spaceassistant/runs/'
  })
}

export function resolveScratchGitPolicy(input: {
  workDir: string
  gitRoot: string
  gitignoreContents: string
}): { kind: 'none' } | { kind: 'scratch-git-policy'; choices: ['add-ignore', 'keep-visible', 'cancel'] | ['keep-visible', 'cancel'] } {
  if (isScratchRunsIgnored(input.gitignoreContents)) return { kind: 'none' }
  const rootInsideWorkDir = !path.relative(input.workDir, input.gitRoot).startsWith('..') && !path.isAbsolute(path.relative(input.workDir, input.gitRoot))
  if (!rootInsideWorkDir) return { kind: 'scratch-git-policy', choices: ['keep-visible', 'cancel'] }
  return { kind: 'scratch-git-policy', choices: ['add-ignore', 'keep-visible', 'cancel'] }
}
import path from 'node:path'
