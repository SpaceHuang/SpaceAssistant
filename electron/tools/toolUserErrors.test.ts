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
    expect(msg).not.toMatch(/Develop\\SpaceAssistant/)
    expect(msg).toMatch(/脚本执行失败/)
  })

  it('style_clone_analyze 有默认文案', () => {
    // Test with error that doesn't match透传 branches
    expect(toToolUserError(new Error(''), { toolName: 'style_clone_analyze' })).toBe(
      '样式分析失败，请检查参考图后重试'
    )
  })

  it('style_clone_synthesize 有默认文案', () => {
    // Test with error that doesn't match透传 branches
    expect(toToolUserError(new Error(''), { toolName: 'style_clone_synthesize' })).toBe(
      '样式合成失败，请稍后重试'
    )
  })

  it('style_clone 有默认文案', () => {
    // Test with error that doesn't match透传 branches
    expect(toToolUserError(new Error(''), { toolName: 'style_clone' })).toBe(
      '样式克隆失败，请稍后重试'
    )
  })

  it('style_clone_verify_report 有默认文案', () => {
    // Test with error that doesn't match透传 branches
    expect(toToolUserError(new Error(''), { toolName: 'style_clone_verify_report' })).toBe(
      '验证报告生成失败，请稍后重试'
    )
  })

  it('style_clone_analyze 的 ENOENT（含路径）映射为友好文案而非通用兜底', () => {
    const msg = toToolUserError(
      new Error("ENOENT: no such file or directory, open 'F:\\工作目录\\a.jpg'"),
      { toolName: 'style_clone_analyze' }
    )
    expect(msg).toBe('示例图读取失败，请检查图片是否已上传或文件是否损坏')
    expect(msg).not.toBe('工具执行失败，请稍后重试')
  })

  it('style_clone 结构化错误码文案（无路径 + CJK）原样保留', () => {
    const structured =
      '[STYLE_CLONE_VISION_EMPTY_RESPONSE] 视觉模型返回空内容（已重试 2 次），请检查视觉模型可用性'
    expect(toToolUserError(new Error(structured), { toolName: 'style_clone_analyze' })).toBe(
      structured
    )
  })
})