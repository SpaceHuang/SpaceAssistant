import { describe, expect, it } from 'vitest'
import { sanitizeToolErrorString, toToolUserError } from './toolUserErrors'

describe('toToolUserError', () => {
  it('sanitizes node_modules paths for generic tools', () => {
    const msg = toToolUserError(
      new Error('ENOENT: E:\\proj\\node_modules\\foo\\bar.js'),
      { toolName: 'read_file' }
    )
    expect(msg).not.toMatch(/node_modules/)
    expect(msg).toMatch(/读取文件失败|文件不存在/)
  })

  it('keeps Chinese business errors', () => {
    expect(sanitizeToolErrorString('路径超出工作目录范围: src/a.ts', 'read_file')).toBe(
      '路径超出工作目录范围: src/a.ts'
    )
  })

  it('delegates browser errors', () => {
    const msg = toToolUserError(
      new Error('require() of ES Module chrome-launcher'),
      { toolName: 'browser', browserKind: 'init' }
    )
    expect(msg).toMatch(/模块兼容性|重启应用/)
  })

  it('sanitizes run_script combined stderr', () => {
    const msg = toToolUserError(
      new Error(
        '脚本执行失败（退出码: 1）\n  File "E:\\\\Develop\\\\SpaceAssistant\\\\test.py", line 1'
      ),
      { toolName: 'run_script' }
    )
    expect(msg).not.toMatch(/Develop\\\\SpaceAssistant/)
    expect(msg).toMatch(/脚本执行失败/)
  })
})
