import { describe, expect, it } from 'vitest'
import { parseLarkCliError } from './larkCliErrors'

describe('larkCliErrors', () => {
  it('maps not configured', () => {
    const r = parseLarkCliError('Error: not configured, run config init')
    expect(r.message).toContain('应用配置')
  })

  it('maps scope errors', () => {
    const r = parseLarkCliError('permission scope im:message missing')
    expect(r.hint).toBeTruthy()
  })

  it('maps Windows cmd not found (GBK)', () => {
    const r = parseLarkCliError("'lark-cli.cmd' 不是内部或外部命令，也不是可运行的程序或批处理文件。")
    expect(r.message).toBe('请先安装 lark-cli')
  })
})
