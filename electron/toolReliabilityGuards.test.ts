import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * R1/R4 的「可 grep 护栏」（方案 §6.2 第 2 条 / §7.3 样式护栏）：
 * 失败即 CI 红，防止后续改动把已消灭的多副本路径改回来。
 */
const root = path.resolve(__dirname, '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

describe('工具调用可靠性护栏（grep 断言）', () => {
  it('护栏 1：env.workspace 不再出现 getActiveWorkDir（全局 active 旁路已删除）', () => {
    const source = read('electron/capabilities/handlers/env.ts')
    const handlerSection = source.slice(source.indexOf('env.workspace'))
    expect(handlerSection).not.toContain('getActiveWorkDir')
  })

  it('护栏 2：toolChatLoop 循环内 workDir 取值以 workspaceRefresh 优先（旧三元不再是唯一路径）', () => {
    const source = read('electron/toolChatLoop.ts')
    expect(source).toContain('workspaceSnapshot?.rootPath ?? (resolveWorkDir ? resolveWorkDir() : initialWorkDir)')
    expect(source).toContain('workspaceRefresh: ports.workspace.refresh')
  })

  it('护栏 3：渲染端工具卡失败态只用 status 推导（不得用 error 字段存在性）', () => {
    const source = read('src/renderer/components/Chat/ToolCallCard.tsx')
    expect(source).toMatch(/isFailed = record\.status === 'failed' || record\.status === 'rejected'/)
    // 失败态推导不得出现「error 存在性」形态
    expect(source).not.toMatch(/status\s*=\s*[^;\n]*\??\.error/)
    expect(source).not.toMatch(/isFailed\s*=[^;\n]*\.error/)
  })

  it('护栏 4：结果信封归一只经 toolResultContract（validator 不再自建矛盾改写逻辑）', () => {
    const source = read('electron/tools/types.ts')
    expect(source).toContain('normalizeToolResultEnvelope')
    // 旧「矛盾即判失败」的静默改写路径不得回归
    expect(source).not.toMatch(/success && status === 'failed'/)
    expect(source).not.toMatch(/!normalized\.success && status === 'succeeded'/)
  })

  it('护栏 5：run_shell 失败码已细分（settle 分支不再产出旧 SHELL_ 执行失败码）', () => {
    const source = read('electron/tools/runShellExecutor.ts')
    expect(source).not.toContain("error: 'SHELL_PROCESS_EXIT'")
    expect(source).not.toContain("error: 'SHELL_TIMEOUT'")
    expect(source).not.toContain("error: 'SHELL_CANCELLED'")
    expect(source).not.toContain("error: 'SHELL_SPAWN_ERROR'")
    expect(source).not.toContain("error: 'SHELL_ARTIFACT_PATH_INVALID'")
  })
})
