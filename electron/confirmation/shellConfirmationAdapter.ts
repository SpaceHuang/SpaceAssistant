import type { ContentFacts, EnvFacts, FactSignal } from '../../src/shared/confirmation/types'
import type { PreparedShellExecution } from '../shell/preparedShellExecution'
import { analyzeShellFacts, type ShellFactAnalysis } from '../shell/shellAnalyzer'
import { buildPathSignal } from './extractors/pathClassifier'

/**
 * 将已封存的 Shell plan 投影为确认事实。
 *
 * 该适配器只做事实投影：不计算 risk、verdict、trust、authorization，也不读写缓存。
 * 因而同一份 PreparedShellExecution 可以被 desktop/IM 的共同 policy 链路消费。
 */
export interface ShellConfirmationProjectionOptions {
  env: EnvFacts
  baseRiskLevel?: ContentFacts['baseRiskLevel']
}

function commandSummary(analysis: ShellFactAnalysis): string {
  const commands = analysis.operations.map((operation) => [operation.verb, ...operation.args].filter(Boolean).join(' '))
  return commands.length ? commands.join(` ${analysis.connectors[0] ?? ';'} `) : '无法解析的 Shell 命令'
}

function commandSignal(analysis: ShellFactAnalysis, profileNamespace: string): FactSignal {
  const commands = analysis.operations.map((operation) => ({
    verb: operation.verb,
    args: [...operation.args],
    signature: [operation.verb, ...operation.args].join(' '),
    profileNamespace,
    ...(operation.segmentIndex > 0
      ? {
          pipesInto: `segment-${operation.segmentIndex - 1}`,
          ...(analysis.connectors[operation.segmentIndex - 1]
            ? { connector: analysis.connectors[operation.segmentIndex - 1] }
            : {})
        }
      : {})
  }))
  return {
    kind: 'command-sequence',
    commands,
    ...(analysis.analysisCompleteness === 'complete' && analysis.connectors.length === 0
      ? { persistable: commands.length === 1 }
      : {})
  }
}

export function projectPreparedShellExecution(
  prepared: PreparedShellExecution,
  options: ShellConfirmationProjectionOptions
): ContentFacts {
  const analysis =
    isShellFactAnalysis(prepared.facts) ? prepared.facts : analyzeShellFacts(prepared.command, prepared.profile.dialect)
  const signals: FactSignal[] = [commandSignal(analysis, `${prepared.profile.id}:${prepared.profile.dialect}`)]
  for (const rawPath of analysis.paths) signals.push(buildPathSignal(rawPath, options.env))
  if (analysis.analysisCompleteness === 'partial') {
    signals.push({ kind: 'extraction-failed', reason: `shell-analysis-incomplete:${analysis.unresolved.join('|') || 'unknown'}` })
  }
  return {
    toolName: 'run_shell',
    actionClass: 'execute',
    baseRiskLevel: options.baseRiskLevel ?? 'high',
    signals,
    summary: {
      text: commandSummary(analysis),
      sections: [
        { label: 'shell_profile', value: prepared.profile.id },
        { label: 'cwd', value: prepared.cwd },
        { label: 'dialect', value: prepared.profile.dialect },
        { label: 'analysis', value: analysis.analysisCompleteness }
      ]
    }
  }
}

function isShellFactAnalysis(value: unknown): value is ShellFactAnalysis {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ShellFactAnalysis>
  return Array.isArray(candidate.operations) && Array.isArray(candidate.connectors) &&
    Array.isArray(candidate.paths) && Array.isArray(candidate.cwdChanges) &&
    (candidate.analysisCompleteness === 'complete' || candidate.analysisCompleteness === 'partial')
}
