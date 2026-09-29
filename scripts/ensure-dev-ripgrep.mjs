// dev 前置「确保当前平台 rg 就绪」(方案 §3.7):
// 复用 prepare-ripgrep.mjs 的 prepareTarget(幂等缓存,常态零网络),只准备当前平台;
// 任何失败仅告警并放行(exit 0),绝不阻塞 npm run dev。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import manifest from './ripgrep-manifest.json' with { type: 'json' }
import { prepareTarget } from './prepare-ripgrep.mjs'

// 支持面以 manifest 为唯一真相源,与 prepare:rg / 打包链路保持同源
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

// 唯一裁决点:无论结果如何都放行(exit 0)——npm 的 pre* 钩子失败会中断主命令,
// grep 不可用只影响 grep,不能拖垮整个 dev 启动(方案 §3.7.3 约束 3)。
export function decideEnsureOutcome(outcome) {
  if (outcome.ok) return { exitCode: 0, warn: null }
  if (outcome.reason === 'unsupported') {
    return {
      exitCode: 0,
      warn: `[ensure-dev-ripgrep] 当前平台 ${process.platform}-${process.arch} 不在 ripgrep 支持面内,跳过准备(grep 工具将不可用,不影响 dev 启动)。`,
    }
  }
  const cause = outcome.error?.message ?? '未知错误'
  return {
    exitCode: 0,
    warn: `[ensure-dev-ripgrep] ripgrep 准备失败:${cause}。grep 工具在本次 dev 会话中不可用;可运行 npm run prepare:rg 手动准备。不阻塞启动。`,
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outcome = await ensureCurrentPlatformRipgrep()
  const decision = decideEnsureOutcome(outcome)
  if (decision.warn) console.warn(decision.warn)
  process.exitCode = decision.exitCode
}
