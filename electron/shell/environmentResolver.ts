import crypto from 'crypto'

const BASE_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'NODE_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
])
const SECRET_NAME = /(api[_-]?key|token|secret|password|passwd|authorization|private[_-]?key)/i

export interface ResolvedEnvironment {
  env: NodeJS.ProcessEnv
  fingerprint: string
  removedKeys: string[]
}

export function resolveShellEnvironment(
  source: NodeJS.ProcessEnv,
  explicitKeys: readonly string[] = []
): ResolvedEnvironment {
  const allowed = new Set([...BASE_KEYS, ...explicitKeys])
  const env: NodeJS.ProcessEnv = {}
  const removedKeys: string[] = []
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!allowed.has(key) || SECRET_NAME.test(key)) {
      removedKeys.push(key)
      continue
    }
    env[key] = value
  }
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(Object.keys(env).sort().map((key) => [key, env[key]])))
    .digest('hex')
  return { env, fingerprint, removedKeys: removedKeys.sort() }
}
