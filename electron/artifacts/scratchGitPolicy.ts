/** Whether .gitignore contains an exact, portable rule for generated scratch runs. */
export function isScratchRunsIgnored(gitignoreContents: string): boolean {
  return gitignoreContents.split(/\r?\n/).some((line) => {
    const rule = line.trim()
    return rule === '.spaceassistant/runs/' || rule === '/.spaceassistant/runs/'
  })
}
