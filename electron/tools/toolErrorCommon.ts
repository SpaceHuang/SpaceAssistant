const PATH_LIKE =
  /(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|Develop|tmp|var|opt|node_modules)(?:\/|\\))|node_modules|dist-electron|ERR_REQUIRE_ESM|require\s*\(\s*\)\s*of\s*ES\s*Module/i

export function containsInternalDetails(msg: string): boolean {
  return PATH_LIKE.test(msg)
}

export function isIntentionalUserHint(msg: string): boolean {
  return /[\u4e00-\u9fff]/.test(msg)
}
