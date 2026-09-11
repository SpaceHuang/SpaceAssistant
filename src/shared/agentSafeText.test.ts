import { describe, expect, it } from 'vitest'
import { sanitizeAgentText } from './agentSafeText'

describe('sanitizeAgentText', () => {
  it('脱敏带空格的 POSIX 路径且保留后续诊断文本', () => {
    const result = sanitizeAgentText('/Users/Alice Smith/private file.txt: Permission denied')
    expect(result.text).not.toContain('Alice Smith/private file.txt')
    expect(result.text).toContain('Permission denied')
    expect(result.text).toContain('<path:redacted>')
  })

  it('处理 path/cwd 冒号边界而不吞掉后续错误信息', () => {
    const result = sanitizeAgentText('cwd:/etc/app secrets; path:/Users/Alice Smith/app.py error: failed')
    expect(result.text).not.toContain('/etc/app')
    expect(result.text).not.toContain('/Users/Alice Smith/app.py')
    expect(result.text).toContain('error: failed')
  })

  it('保留 URL、相对路径、包路径和行列号', () => {
    const result = sanitizeAgentText(
      'https://example.com/a?file=/Users/Alice/a.txt src/shared/file.ts node_modules/pkg/index.js 1/2 /tmp/app.py:37:4'
    )
    expect(result.text).toContain('https://example.com/a?file=/Users/Alice/a.txt')
    expect(result.text).toContain('src/shared/file.ts')
    expect(result.text).toContain('node_modules/pkg/index.js')
    expect(result.text).toContain('1/2')
    expect(result.text).toContain('<path:redacted>:37:4')
  })

  it('处理 Windows、UNC 和 traceback 引号路径', () => {
    const result = sanitizeAgentText(
      'File "C:\\Users\\Alice Smith\\app.py", line 37\n\\\\server\\share\\private file.txt'
    )
    expect(result.text).not.toContain('Alice Smith')
    expect(result.text).not.toContain('\\\\server\\share\\private file.txt')
    expect(result.text).toContain('line 37')
  })

  it('不依赖有限错误关键词，也不会吞掉模糊路径后的正文', () => {
    const result = sanitizeAgentText(
      'Error at /tmp/a.py because module foo is missing\n/tmp/a.py:3:4 ValueError: bad input'
    )
    expect(result.text).toContain('because module foo is missing')
    expect(result.text).toContain('ValueError: bad input')
    expect(result.text).toContain('<path:redacted>')
    expect(result.redactionReason).toBe('absolute_path')
  })

  it('模糊路径不会保留无法归类的后缀', () => {
    const result = sanitizeAgentText('/tmp/private file')
    expect(result.text).toContain('<path:redacted>')
    expect(result.text).not.toContain('file')
    expect(result.redactionReason).toBe('ambiguous_path')
  })
})
