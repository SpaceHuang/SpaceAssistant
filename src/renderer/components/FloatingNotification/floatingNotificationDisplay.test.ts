import { describe, it, expect } from 'vitest'
import {
  formatFloatingActionSummary,
  formatFloatingMainLabel
} from './floatingNotificationDisplay'

const tChat = (key: string, options?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    'confirm.write.writeAction': `写入「${options?.fileName ?? ''}」`,
    'confirm.write.editAction': `编辑「${options?.fileName ?? ''}」`,
    'confirm.write.writeFileFallback': '写入文件',
    'confirm.write.editFileFallback': '编辑文件',
    'confirm.shell.executeTitle': '执行 Shell 命令',
    'confirm.script.actionSummary': '运行 Python 脚本'
  }
  return map[key] ?? key
}

const tNotif = (key: string, options?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    pendingConfirm: `待你确认：${options?.action ?? ''}`,
    pendingConfirmShell: `待你确认执行：${options?.command ?? ''}`,
    morePendingSuffix: `（共 ${options?.count ?? 0} 项）`
  }
  return map[key] ?? key
}

describe('floatingNotificationDisplay', () => {
  it('should lead with confirmation intent for file writes', () => {
    expect(
      formatFloatingMainLabel(
        {
          toolName: 'write_file',
          input: { path: 'src/app.ts' },
          totalItems: 1
        },
        tChat,
        tNotif
      )
    ).toBe('待你确认：写入「app.ts」')
  })

  it('should state shell execution explicitly', () => {
    expect(
      formatFloatingMainLabel(
        {
          toolName: 'run_shell',
          input: { command: 'npm test' },
          totalItems: 1
        },
        tChat,
        tNotif
      )
    ).toBe('待你确认执行：npm test')
  })

  it('should append total count when multiple items pending', () => {
    expect(
      formatFloatingMainLabel(
        {
          toolName: 'run_shell',
          input: { command: 'npm test' },
          totalItems: 3
        },
        tChat,
        tNotif
      )
    ).toBe('待你确认执行：npm test（共 3 项）')
  })

  it('should keep action summary aligned with confirm cards', () => {
    expect(formatFloatingActionSummary('write_file', { path: 'src/app.ts' }, tChat)).toBe(
      '写入「app.ts」'
    )
  })
})
