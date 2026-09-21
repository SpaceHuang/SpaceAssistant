import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 契约形状断言(A1,偏差 17 防退化):契约文件(src/shared/agent/invocation.ts)
 * 禁函数属性字段——宿主能力一律以接口方法简写声明(「端口一律接口」),
 * 绑定层适配器是唯一允许的函数形态且不出现在契约文件内。
 * 方法简写(name?(args): T)不产生 `=>`;函数属性(name?: (args) => T)必然产生 `=>`。
 */

const CONTRACT_FILE = path.resolve(process.cwd(), 'src', 'shared', 'agent', 'invocation.ts')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('契约形状断言(A1,偏差 17)', () => {
  const source = readFileSync(CONTRACT_FILE, 'utf-8')
  const code = stripComments(source)

  it('契约文件非注释代码不含箭头函数形态(禁函数属性字段)', () => {
    const violations = code
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(({ text }) => text.includes('=>'))
    expect(violations, JSON.stringify(violations)).toEqual([])
  })

  it('宿主端口符号均为接口方法形态(白名单存在性)', () => {
    for (const signature of [
      'resolveApiKey(): Promise<string | null>',
      'resolveWorkDir?(): string',
      'getBrowserDetectContext?(): BrowserDetectContext',
      'turnBoundary?(input: unknown): Promise<void>',
      'translate?(message: LocalizedMessage): string',
      'touchTrustedCommand(command: string): void'
    ]) {
      expect(code.includes(signature), signature).toBe(true)
    }
  })
})
