import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeAgentText, setKnownHomeDir } from './agentSafeText'

afterEach(() => setKnownHomeDir(undefined))

describe('sanitizeAgentText', () => {
  describe('主目录前缀折叠为 ~', () => {
    it('Windows 原生反斜杠形态', () => {
      setKnownHomeDir('C:\\Users\\alice')
      const result = sanitizeAgentText('cannot read C:\\Users\\alice\\docs\\a.txt')
      expect(result.text).toBe('cannot read ~\\docs\\a.txt')
      expect(result.redacted).toBe(true)
      expect(result.redactionReason).toBeUndefined()
    })

    it('正斜杠形态', () => {
      setKnownHomeDir('C:\\Users\\alice')
      expect(sanitizeAgentText('open C:/Users/alice/docs/a.txt').text).toBe('open ~/docs/a.txt')
    })

    it('JSON 转义反斜杠形态（保持 JSON 可解析）', () => {
      setKnownHomeDir('C:\\Users\\alice')
      const result = sanitizeAgentText('{"cwd":"C:\\\\Users\\\\alice\\\\x"}')
      expect(result.text).toBe('{"cwd":"~\\\\x"}')
      expect(() => JSON.parse(result.text)).not.toThrow()
    })

    it('Git Bash / MSYS 形态', () => {
      setKnownHomeDir('C:\\Users\\alice')
      expect(sanitizeAgentText('bash: /c/Users/alice/x not found').text).toBe('bash: ~/x not found')
    })

    it('WSL 与 Cygwin 形态', () => {
      setKnownHomeDir('C:\\Users\\alice')
      expect(sanitizeAgentText('wsl: /mnt/c/Users/alice/x not found').text).toBe('wsl: ~/x not found')
      expect(sanitizeAgentText('cygwin: /cygdrive/c/Users/alice/x').text).toBe('cygwin: ~/x')
      expect(sanitizeAgentText('/mnt/c/Users/aliceX stays').text).toBe('/mnt/c/Users/aliceX stays')
    })

    it('POSIX 主目录（含前导斜杠整体折叠）', () => {
      setKnownHomeDir('/Users/alice')
      expect(sanitizeAgentText('err at /Users/alice/x/y.py:3').text).toBe('err at ~/x/y.py:3')
      expect(sanitizeAgentText('see /Users/alice here').text).toBe('see ~ here')
    })

    it('UNC 主目录形态（原生与 JSON 转义，review D1）', () => {
      setKnownHomeDir('\\\\NAS\\share\\users\\alice')
      expect(sanitizeAgentText('err \\\\NAS\\share\\users\\alice\\x').text).toBe('err ~\\x')
      expect(sanitizeAgentText('{"p":"\\\\\\\\NAS\\\\share\\\\users\\\\alice\\\\x"}').text).toBe('{"p":"~\\\\x"}')
    })

    it('中文行文紧贴路径时仍折叠（review v2 B1 隐私回归）', () => {
      setKnownHomeDir('C:\\Users\\alice')
      expect(sanitizeAgentText('文件位于C:\\Users\\alice\\x.txt中').text).toBe('文件位于~\\x.txt中')
      setKnownHomeDir('/Users/alice')
      expect(sanitizeAgentText('错误在/Users/alice/x.py，请检查').text).toBe('错误在~/x.py，请检查')
    })

    it('非 ASCII 用户名边界（review O1）', () => {
      setKnownHomeDir('C:\\Users\\张三')
      expect(sanitizeAgentText('读 C:\\Users\\张三\\文档\\a.md').text).toBe('读 ~\\文档\\a.md')
      // CJK 标点不是路径段内字符，后界放行，主目录本身仍折叠。
      expect(sanitizeAgentText('在 C:\\Users\\张三。之后继续').text).toBe('在 ~。之后继续')
      expect(sanitizeAgentText('C:\\Users\\张三丰\\x stays').text).toBe('C:\\Users\\张三丰\\x stays')
    })

    it('主目录自身前后边界外的相似文本不误伤', () => {
      setKnownHomeDir('C:\\Users\\alice')
      expect(sanitizeAgentText('C:\\Users\\aliceX\\y stays').text).toBe('C:\\Users\\aliceX\\y stays')
      expect(sanitizeAgentText('C:\\Users\\alice.txt stays').text).toBe('C:\\Users\\alice.txt stays')
      setKnownHomeDir('/Users/alice')
      expect(sanitizeAgentText('x/Users/alice and ./Users/alice stay').text).toBe(
        'x/Users/alice and ./Users/alice stay'
      )
    })

    it('非主目录绝对路径原样放行（不再猜测路径）', () => {
      setKnownHomeDir('/Users/alice')
      const text = '/usr/bin/tool and E:\\Develop\\x and /etc/hosts stay'
      expect(sanitizeAgentText(text).text).toBe(text)
    })

    it('未注入主目录时不做任何路径替换', () => {
      const text = '/Users/alice/x and C:\\Users\\alice\\y'
      const result = sanitizeAgentText(text)
      expect(result.text).toBe(text)
      expect(result.redacted).toBe(false)
    })
  })

  describe('秘密脱敏', () => {
    it('遮盖 KEY/TOKEN 赋值与 Bearer token，保留上下文', () => {
      const result = sanitizeAgentText('ValueError: bad API_KEY=abc123 Bearer eyJtoken')
      expect(result.text).toBe('ValueError: bad API_KEY=<secret:redacted> Bearer <secret:redacted>')
      expect(result.redacted).toBe(true)
      expect(result.redactionReason).toBe('secret')
    })

    it('PEM 块整块替换且不被 SECRET: 二次命中', () => {
      const result = sanitizeAgentText('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- ok')
      expect(result.text).toBe('<secret:redacted> ok')
      expect(result.redactionReason).toBe('secret')
    })
  })

  describe('散文不再被误伤（回归）', () => {
    it('“X / Y” 斜杠与文档正文原样保留', () => {
      setKnownHomeDir('/Users/alice')
      const cases = [
        '哪个会话 / 哪个模型最耗 token？',
        '按日期 / 会话 / 模型 / APP 版本号四个维度',
        '主：输入 / 输出 token',
        '{服务名} / {模型名}',
        '`Σ(cacheReadTokens) / Σ(inputTokens)`',
        '配额 50 /50 用满即止'
      ]
      for (const text of cases) {
        const result = sanitizeAgentText(text)
        expect(result.text, text).toBe(text)
        expect(result.redacted, text).toBe(false)
      }
    })

    it('相对路径与 URL 原样保留', () => {
      const text = 'src/shared/file.ts docs/requirement/x.md https://example.com/a?file=/x'
      expect(sanitizeAgentText(text).text).toBe(text)
    })
  })
})
