import path from 'node:path'

export type ScratchGitSavedPolicy = 'add-ignore' | 'keep-visible'

/** Config key for a workspace profile's remembered scratch Git policy. */
export function scratchGitPolicyConfigKey(profileId: string): string {
  return `artifact.scratchGitPolicy.${profileId}`
}

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
  savedPolicy?: ScratchGitSavedPolicy
}): { kind: 'none' } | { kind: 'scratch-git-policy'; choices: ['add-ignore', 'keep-visible', 'cancel'] | ['keep-visible', 'cancel'] } {
  if (isScratchRunsIgnored(input.gitignoreContents)) return { kind: 'none' }
  const validated = validateSavedScratchGitPolicy(input.savedPolicy, input.gitignoreContents)
  if (validated.valid && validated.savedPolicy) return { kind: 'none' }
  const relative = path.relative(input.workDir, input.gitRoot)
  const rootInsideWorkDir = !relative.startsWith('..') && !path.isAbsolute(relative)
  if (!rootInsideWorkDir) return { kind: 'scratch-git-policy', choices: ['keep-visible', 'cancel'] }
  return { kind: 'scratch-git-policy', choices: ['add-ignore', 'keep-visible', 'cancel'] }
}

/** Produces a minimal .gitignore update for generated run files and verifies the result. */
export function appendScratchRunsIgnore(gitignoreContents: string): string {
  if (isScratchRunsIgnored(gitignoreContents)) return gitignoreContents
  const prefix = gitignoreContents && !gitignoreContents.endsWith('\n') ? `${gitignoreContents}\n` : gitignoreContents
  const updated = `${prefix}.spaceassistant/runs/\n`
  if (!isScratchRunsIgnored(updated)) throw new Error('Unable to verify scratch .gitignore rule')
  return updated
}

export function validateSavedScratchGitPolicy(
  savedPolicy: ScratchGitSavedPolicy | undefined,
  gitignoreContents: string
): { valid: boolean; savedPolicy?: ScratchGitSavedPolicy } {
  if (savedPolicy === 'add-ignore' && !isScratchRunsIgnored(gitignoreContents)) return { valid: false, savedPolicy: undefined }
  return savedPolicy ? { valid: true, savedPolicy } : { valid: true }
}
