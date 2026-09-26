import { describe, expect, it } from 'vitest'
import { prepareShellExecution } from '../shell/preparedShellExecution'
import { projectPreparedShellExecution } from './shellConfirmationAdapter'

const env = { os: 'darwin', workDir: '/tmp/project', sensitivePaths: ['/tmp/project/.env'] }
const prepared = (command: string, facts?: unknown) => prepareShellExecution({
  command,
  profile: { id: 'builtin-macos-bash', dialect: 'posix-bash', executable: '/bin/bash', outputEncoding: { kind: 'utf8' } },
  spawnSpec: { executable: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], shellId: 'bash' },
  cwd: env.workDir,
  timeoutMs: 30_000,
  environment: { PATH: '/usr/bin' },
  facts: facts ?? {},
  configRevision: 'config-1',
  policyRevision: 'policy-1'
})

describe('ShellConfirmationAdapter', () => {
  it('projects real connectors, command facts and path facts without authorization fields', () => {
    const facts = projectPreparedShellExecution(prepared('cd src && cat ./config.json | head -n 2'), { env })
    expect(facts.toolName).toBe('run_shell')
    expect(facts.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command-sequence' }),
      expect.objectContaining({ kind: 'path-target', path: './config.json', zone: 'workdir-normal' })
    ]))
    expect(facts.summary.sections).toEqual(expect.arrayContaining([
      { label: 'cwd', value: '/tmp/project' },
      { label: 'dialect', value: 'posix-bash' }
    ]))
    expect(facts).not.toHaveProperty('verdict')
    expect(facts).not.toHaveProperty('skipConfirm')
  })

  it('把 exact shell signature 绑定到 profile/dialect namespace', () => {
    const facts = projectPreparedShellExecution(prepared('echo ok'), { env })
    const sequence = facts.signals.find((signal) => signal.kind === 'command-sequence')
    expect(sequence?.kind === 'command-sequence' && sequence.commands[0]).toMatchObject({
      signature: 'echo ok',
      profileNamespace: 'builtin-macos-bash:posix-bash'
    })
  })

  it('marks incomplete shell analysis instead of treating it as allow', () => {
    // P3 评审登记（golden-review PS/Bash 段）：`echo ok > ./.env` 在 bash 语法级分叉下完整解析
    // → complete → 不再触发 shell-analysis-incomplete 的 extraction-failed 投影（发现 E 链路）；
    // 安全面不弱化：.env 敏感路径仍由 path-target（sensitive-file）信号覆盖，
    // 且重定向目标经树事实路径增强进入 pathVerdict（只增不减）。
    const facts = projectPreparedShellExecution(prepared('echo ok > ./.env'), { env })
    expect(facts.signals).not.toContainEqual(expect.objectContaining({ kind: 'extraction-failed', reason: expect.stringContaining('shell-analysis-incomplete') }))
    expect(facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', path: './.env', zone: 'sensitive-file' }))
  })

  it('consumes the prepared facts snapshot when it is complete', () => {
    const snapshot = {
      dialect: 'posix-bash', operations: [{ verb: 'printf', args: ['ok'], segmentIndex: 0 }], connectors: [],
      paths: [], redirects: [], cwdChanges: [], analysisCompleteness: 'complete', unresolved: []
    } as const
    const facts = projectPreparedShellExecution(prepared('this input is ignored', snapshot), { env })
    expect(facts.summary.text).toContain('printf ok')
  })
})
