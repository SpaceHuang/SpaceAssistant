import type { GithubSkillCandidate } from '../../shared/domainTypes'

/** 勾选状态 → 安装请求的判定结果（纯函数，便于单测 A18/A21/A24） */
export type GithubInstallPlan =
  | { mode: 'batch'; subPaths: string[]; overwrite: boolean }
  | { mode: 'whole-repo' }
  | { mode: 'blocked'; reason: 'no-selection' | 'stale-probe' }

export type GithubInstallPlanInput = {
  /** 当前输入框里的地址 */
  url: string
  /** 候选列表来源的地址（探测时的 URL）；未探测为 null */
  probedUrl: string | null
  candidates: Array<Pick<GithubSkillCandidate, 'name' | 'subPath' | 'status'>>
  selectedPaths: string[]
}

/**
 * 判定 GitHub 安装请求：
 * - 未探测（无候选）→ 整仓安装
 * - 候选来源 URL 与当前 URL 不一致 → 拦截（候选与 URL 绑定，不得把旧 subPath 用于新 URL）
 * - 探测后零勾选 → 拦截并提示，严禁退化为整仓安装
 * - 否则批量安装；本次 overwrite = 所选候选中存在同名候选
 */
export function planGithubInstall(input: GithubInstallPlanInput): GithubInstallPlan {
  const url = input.url.trim()
  if (input.candidates.length === 0) return { mode: 'whole-repo' }

  if (!input.probedUrl || input.probedUrl.trim() !== url) return { mode: 'blocked', reason: 'stale-probe' }
  if (input.selectedPaths.length === 0) return { mode: 'blocked', reason: 'no-selection' }

  const subPaths = [...input.selectedPaths]
  return { mode: 'batch', subPaths, overwrite: overwriteConflictNames(input.candidates, subPaths).length > 0 }
}

/**
 * 本次批量调用「将被覆盖」的同名候选名称：只统计被勾选的 name-conflict 候选，
 * 去重后保持候选顺序。N > 1 时 UI 需据此弹二次确认并列出名单。
 */
export function overwriteConflictNames(
  candidates: Array<Pick<GithubSkillCandidate, 'name' | 'subPath' | 'status'>>,
  subPaths: string[]
): string[] {
  const selected = new Set(subPaths)
  const names: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.status !== 'name-conflict' || !selected.has(candidate.subPath)) continue
    if (seen.has(candidate.name)) continue
    seen.add(candidate.name)
    names.push(candidate.name)
  }
  return names
}
