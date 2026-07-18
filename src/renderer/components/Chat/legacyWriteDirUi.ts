/** Legacy write-dir confirm UI applies only when workspace layout is on and artifact management is off for the session. */
export function shouldShowLegacyWriteDirUi(
  workspaceLayoutEnabled: boolean | undefined,
  artifactManagementEnabled: boolean | undefined
): boolean {
  return Boolean(workspaceLayoutEnabled) && artifactManagementEnabled !== true
}
