import { describe, expect, it } from 'vitest'
import { preprocessShellLogFields, redactShellCommandForLog, shellIoPreviewForLog } from './shellLogFields'

describe('shellLogFields', () => {
  it('redacts inline secrets in command', () => {
    const redacted = redactShellCommandForLog('curl -u admin:secret --token abc123 deploy')
    expect(String(redacted)).toContain('--token ***')
    expect(String(redacted)).toContain('-u ***')
    expect(String(redacted)).not.toContain('abc123')
  })

  it('redacts env-style secrets in command', () => {
    const redacted = redactShellCommandForLog('export API_KEY=sk-ant-test && npm run build')
    expect(String(redacted)).toContain('API_KEY=***')
    expect(String(redacted)).not.toContain('sk-ant-test')
  })

  it('preprocessShellLogFields converts command and io to previews', () => {
    const out = preprocessShellLogFields({
      command: 'echo hello',
      stdout: 'hello\n',
      stderr: '',
      description: 'test run'
    })
    expect(out.command).toBeUndefined()
    expect(out.commandRedacted).toBe('echo hello')
    expect(out.stdout).toBeUndefined()
    expect(out.stdoutLen).toBe(6)
    expect(out.stdoutPreview).toBe('hello\n')
    expect(out.description).toBe('test run')
  })

  it('shellIoPreviewForLog marks long output truncated', () => {
    const long = 'x'.repeat(5000)
    const preview = shellIoPreviewForLog(long, 'stderr')
    expect(preview.stderrLen).toBe(5000)
    expect(preview.stderrPreviewTruncated).toBe(true)
  })
})
