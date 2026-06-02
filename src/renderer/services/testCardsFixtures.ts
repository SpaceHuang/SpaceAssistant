import type { BrowserDependencyToolError } from '../../shared/browserTypes'
import type { ToolCallRecord } from '../../shared/domainTypes'

export interface TestCardFixture {
  id: string
  label: string
  toolCall: ToolCallRecord
}

const dependencyRecovery: BrowserDependencyToolError = {
  errorCode: 'chromium_missing',
  errorMessage: 'Chromium 浏览器未安装',
  recommendedCwd: 'E:\\Develop\\SpaceAssistant',
  installCommand: 'npx playwright install chromium',
  detectResult: {
    stagehand: { installed: true, version: '3.0.0' },
    playwright: { installed: true, browsers: ['chromium'] },
    chromium: { ready: false },
    node: { version: 'v22.0.0', meetsRequirement: true },
    canInitialize: false,
    primaryFailure: 'chromium_missing',
    errors: ['Chromium 浏览器未安装'],
    recommendedCwd: 'E:\\Develop\\SpaceAssistant',
    installContext: 'development'
  }
}

function fixture(id: string, label: string, toolCall: ToolCallRecord): TestCardFixture {
  return { id, label, toolCall: { ...toolCall, id: toolCall.id || id } }
}

export function getAllTestCardFixtures(): TestCardFixture[] {
  const now = Date.now()
  return [
    fixture('write-confirm-diff', '[Test] WriteConfirmCard · confirming · diff', {
      id: 'write-confirm-diff',
      toolName: 'write_file',
      input: { path: 'notes.txt', content: 'hello' },
      status: 'confirming',
      riskLevel: 'medium',
      confirmDiff: { oldContent: '', newContent: 'hello', oldPath: 'notes.txt' }
    }),
    fixture('write-success', '[Test] WriteSuccessCard · completed · success', {
      id: 'write-success',
      toolName: 'write_file',
      input: { path: 'notes.txt', content: 'hello' },
      status: 'completed',
      riskLevel: 'medium',
      result: { success: true },
      completedAt: now,
      confirmDiff: { oldContent: '', newContent: 'hello', oldPath: 'notes.txt' }
    }),
    fixture('browser-confirm', '[Test] BrowserConfirmCard · confirming · navigate', {
      id: 'browser-confirm',
      toolName: 'browser',
      input: { action: 'navigate', mode: 'open', url: 'https://www.zhihu.com/billboard' },
      status: 'confirming',
      riskLevel: 'medium'
    }),
    fixture('browser-dependency-guide', '[Test] BrowserDependencyGuideCard · failed · dependencyRecovery', {
      id: 'browser-dependency-guide',
      toolName: 'browser',
      input: { action: 'navigate', mode: 'open', url: 'https://example.com' },
      status: 'failed',
      riskLevel: 'medium',
      result: { success: false, error: 'Chromium 浏览器未安装', dependencyRecovery }
    }),
    fixture('shell-confirm-normal', '[Test] ShellConfirmCard · confirming · normal', {
      id: 'shell-confirm-normal',
      toolName: 'run_shell',
      input: { command: 'npm install', description: '下载 Playwright Chromium 浏览器（约 150-200MB，需联网）' },
      status: 'confirming',
      riskLevel: 'high'
    }),
    fixture('shell-confirm-risk', '[Test] ShellConfirmCard · confirming · riskAck', {
      id: 'shell-confirm-risk',
      toolName: 'run_shell',
      input: { command: 'rm -rf /tmp/test' },
      status: 'confirming',
      riskLevel: 'high',
      shellSecurityHints: {
        requiresRiskAck: true,
        outsideWorkDirRisk: true,
        warnings: ['命令包含工作目录外的路径']
      }
    }),
    fixture('script-confirm', '[Test] ScriptConfirmCard · confirming', {
      id: 'script-confirm',
      toolName: 'run_script',
      input: { code: 'print("hello")' },
      status: 'confirming',
      riskLevel: 'high'
    }),
    fixture('lark-cli-write', '[Test] LarkCliConfirmCard · confirming · write', {
      id: 'lark-cli-write',
      toolName: 'run_lark_cli',
      input: { args: ['message', 'send', '--chat-id', 'oc_x', '--text', 'hello'] },
      status: 'confirming',
      riskLevel: 'high'
    }),
    fixture('lark-cli-read', '[Test] LarkCliConfirmCard · confirming · readOnly', {
      id: 'lark-cli-read',
      toolName: 'run_lark_cli',
      input: { args: ['message', 'search', '--query', 'hello'] },
      status: 'confirming',
      riskLevel: 'high'
    }),
    fixture('grep-calling', '[Test] tool-row · calling · grep', {
      id: 'grep-calling',
      toolName: 'grep',
      input: { pattern: 'foo', path: 'src' },
      status: 'calling',
      riskLevel: 'low'
    }),
    fixture('grep-executing', '[Test] tool-row · executing · grep', {
      id: 'grep-executing',
      toolName: 'grep',
      input: { pattern: 'foo', path: 'src' },
      status: 'executing',
      riskLevel: 'low'
    }),
    fixture('grep-completed', '[Test] tool-row · completed · grep (collapsed)', {
      id: 'grep-completed',
      toolName: 'grep',
      input: { pattern: 'foo', path: 'src' },
      status: 'completed',
      riskLevel: 'low',
      result: { success: true, data: [{ file: 'src/a.ts', line: 1, content: 'foo bar' }] },
      completedAt: now
    }),
    fixture('grep-failed', '[Test] tool-row · failed · grep', {
      id: 'grep-failed',
      toolName: 'grep',
      input: { pattern: 'foo' },
      status: 'failed',
      riskLevel: 'low',
      result: { success: false, error: '搜索超时' }
    }),
    fixture('grep-rejected', '[Test] tool-row · rejected · grep', {
      id: 'grep-rejected',
      toolName: 'grep',
      input: { pattern: 'foo' },
      status: 'rejected',
      riskLevel: 'low',
      result: { success: false, error: '用户拒绝' }
    }),
    fixture('read-file-completed', '[Test] tool-row · completed · read_file (collapsed)', {
      id: 'read-file-completed',
      toolName: 'read_file',
      input: { path: 'README.md' },
      status: 'completed',
      riskLevel: 'low',
      result: { success: true, data: '# Hello\n\nWorld' },
      completedAt: now
    }),
    fixture('list-directory-completed', '[Test] tool-row · completed · list_directory (collapsed)', {
      id: 'list-directory-completed',
      toolName: 'list_directory',
      input: { path: 'src' },
      status: 'completed',
      riskLevel: 'low',
      result: { success: true, data: [{ name: 'a.ts', type: 'file' }] },
      completedAt: now
    }),
    fixture('browser-executing', '[Test] tool-row · executing · browser (collapsed)', {
      id: 'browser-executing',
      toolName: 'browser',
      input: { action: 'navigate', mode: 'open', url: 'https://example.com' },
      status: 'executing',
      riskLevel: 'medium'
    }),
    fixture('browser-failed', '[Test] tool-row · failed · browser (collapsed)', {
      id: 'browser-failed',
      toolName: 'browser',
      input: { action: 'observe', instruction: 'x' },
      status: 'failed',
      riskLevel: 'medium',
      result: { success: false, error: '失败' }
    }),
    fixture('browser-detect-executing', '[Test] tool-row · executing · browser_detect', {
      id: 'browser-detect-executing',
      toolName: 'browser_detect',
      input: {},
      status: 'executing',
      riskLevel: 'low'
    }),
    fixture('browser-detect-completed', '[Test] tool-row · completed · browser_detect (collapsed)', {
      id: 'browser-detect-completed',
      toolName: 'browser_detect',
      input: {},
      status: 'completed',
      riskLevel: 'low',
      result: {
        success: true,
        data: {
          canInitialize: false,
          primaryFailure: 'chromium_missing',
          errors: ['Chromium 浏览器未安装']
        }
      },
      completedAt: now
    }),
    fixture('browser-detect-failed', '[Test] tool-row · failed · browser_detect (expanded)', {
      id: 'browser-detect-failed',
      toolName: 'browser_detect',
      input: {},
      status: 'failed',
      riskLevel: 'low',
      result: { success: false, error: '检测超时' }
    }),
    fixture('shell-executing-plain', '[Test] tool-row · executing · run_shell plain progress', {
      id: 'shell-executing-plain',
      toolName: 'run_shell',
      input: { command: 'npm install' },
      status: 'executing',
      riskLevel: 'medium',
      progressOutput: 'added 47 packages in 3s'
    }),
    fixture('shell-executing-tui', '[Test] tool-row · executing · run_shell TUI hint', {
      id: 'shell-executing-tui',
      toolName: 'run_shell',
      input: { command: 'less README.md' },
      status: 'executing',
      riskLevel: 'medium'
    }),
    fixture('shell-completed-plain', '[Test] tool-row · completed · run_shell plain output', {
      id: 'shell-completed-plain',
      toolName: 'run_shell',
      input: { command: 'git status' },
      status: 'completed',
      riskLevel: 'medium',
      result: {
        success: true,
        data: { stdout: 'On branch main\nnothing to commit', stderr: '', exitCode: 0 }
      },
      completedAt: now
    }),
    fixture('shell-failed-stderr', '[Test] tool-row · failed · run_shell stderr', {
      id: 'shell-failed-stderr',
      toolName: 'run_shell',
      input: { command: 'npm run build' },
      status: 'failed',
      riskLevel: 'medium',
      result: {
        success: false,
        error: '命令执行失败（退出码: 1）',
        data: { stdout: '', stderr: 'error TS2322: type mismatch', exitCode: 1 }
      },
      completedAt: now
    })
  ]
}
