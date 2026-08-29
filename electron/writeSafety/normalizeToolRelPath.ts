/** Normalize workspace-relative tool paths for lease and conflict keys. */
export function normalizeToolRelPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
}
