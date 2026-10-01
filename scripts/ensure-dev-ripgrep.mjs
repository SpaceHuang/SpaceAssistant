// Dev 启动前确保当前平台的 ripgrep 已准备；失败只告警，不阻断应用启动。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import manifest from './ripgrep-manifest.json' with { type: 'json' }
import { prepareTarget } from './prepare-ripgrep.mjs'

export function resolveEnsureTarget(platform, arch) {
  const key = `${platform}-${arch}`
  return manifest.targets[key] ? key : null
}

export async function ensureCurrentPlatformRipgrep(deps = {}) {
  const prepare = deps.prepareTarget ?? prepareTarget
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const target = resolveEnsureTarget(platform, arch)
  if (!target) return { ok: false, reason: 'unsupported', target: null, error: null }
  try {
    await prepare(target)
    return { ok: true, reason: 'ready', target, error: null }
  } catch (error) {
    return { ok: false, reason: 'prepare_failed', target, error }
  }
}

export function decideEnsureOutcome(outcome) {
  if (outcome.ok) return { exitCode: 0, warn: null }
  if (outcome.reason === 'unsupported') {
    return {
      exitCode: 0,
      warn: `[ensure-dev-ripgrep] 当前平台 ${outcome.target ?? 'unknown'} 不在 ripgrep 支持范围内，跳过准备（不影响 dev 启动）。`
    }
  }
  const cause = outcome.error?.message ?? '未知错误'
  return {
    exitCode: 0,
    warn: `[ensure-dev-ripgrep] ripgrep 准备失败：${cause}。grep 工具在本次 dev 会话中不可用；可运行 npm run prepare:rg 手动准备。不阻塞启动。`
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outcome = await ensureCurrentPlatformRipgrep()
  const decision = decideEnsureOutcome(outcome)
  if (decision.warn) console.warn(decision.warn)
  process.exitCode = decision.exitCode
}
