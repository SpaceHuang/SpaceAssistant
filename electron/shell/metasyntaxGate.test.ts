// P3-T4：metasyntax 信任闸门防线（自原 P2-T5 并入——改造前建档、改造后重跑一步完成）。
// 三批断言：真值表（全部元语法类别 ≥24 条）+ 无假阴性 fuzz（≥500）+ parseShellCommandForTrust persistable 专项。
// 说明：P3 双轨改造的落地形态为「签名组件与共享原语零改动 + facts 层 dialect 分叉」
// （签名 Golden 102 条逐字节零漂移已证明零等价类合并风险），本防线对旧实现恒真，
// 是未来的实质防线——任何触及 metasyntax 判定/签名的改动必须保持三批断言全绿。
import { commandHasShellMetasyntax, parseShellCommandForTrust } from './shellCommandParser'
import { normalizeShellSignature } from '../confirmation/extractors/commandSequenceExtractor'

describe('metasyntax 闸门防线（P3-T4，§3 不变量 6）', () => {
  describe('真值表：全部元语法类别 ≥24 条（引号内包裹形态现状同样断言 true——引号不感知启发式，禁止顺手改）', () => {
    const TRUE_CASES: Array<[string, string]> = [
      ['newline', 'echo a\necho b'],
      ['crlf', 'echo a\recho b'],
      ['backtick', 'echo `cmd`'],
      ['command-subst', 'echo $(pwd)'],
      ['brace-param', 'echo ${HOME}'],
      ['var-expand', 'echo $HOME'],
      ['pipe', 'echo a | grep b'],
      ['semicolon', 'echo a; echo b'],
      ['and', 'echo a && echo b'],
      ['or', 'echo a || echo b'],
      ['redirect-out', 'echo x > out.txt'],
      ['redirect-in', 'cat < in.txt'],
      ['ampersand-bg', 'sleep 10 &'],
      ['glob-star', 'rm ./*'],
      ['glob-question', 'cat file?.txt'],
      ['assign-prefix', 'FOO=1 cmd'],
      ['quoted-pipe', 'echo "a | b"'],
      ['quoted-and', 'echo "a && b"'],
      ['quoted-subst', 'echo "$(x)"'],
      ['quoted-semicolon', 'echo "a;b"'],
      ['quoted-glob', 'echo "*.txt"'],
      ['quoted-var', 'echo "$HOME"'],
      ['quoted-redirect', 'echo "a>b"'],
      ['mixed-meta', 'echo $(cat f) | grep x'],
      ['trailing-pipe', 'ls |']
    ]
    it.each(TRUE_CASES)('%s → true', (_name, cmd) => {
      expect(commandHasShellMetasyntax(cmd)).toBe(true)
    })
  })

  describe('无假阴性 fuzz（确定性种子 ≥500：引号外含元语法的样本断言 true）', () => {
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    it('500 份含元语法样本恒 true（引号内外均含）', () => {
      const rand = mulberry32(0x6d657461)
      const metas = ['|', '&&', '||', ';', '>', '<', '&', '*', '?', '$(', '${', '`', '$X', '\n']
      const plain = ['echo', 'cat', 'ls', 'grep', 'find']
      let trueCount = 0
      for (let i = 0; i < 500; i += 1) {
        const meta = metas[Math.floor(rand() * metas.length)]
        const cmd = plain[Math.floor(rand() * plain.length)]
        const quoted = rand() < 0.5
        const sample = quoted ? `${cmd} "${meta} x"` : `${cmd} x ${meta} y`
        if (commandHasShellMetasyntax(sample)) trueCount += 1
        else throw new Error(`metasyntax 假阴性: ${JSON.stringify(sample)}`)
      }
      expect(trueCount).toBe(500)
    })

    it('真正负例（无元语法普通命令）恒 false', () => {
      expect(commandHasShellMetasyntax('echo hello world')).toBe(false)
      expect(commandHasShellMetasyntax('git status')).toBe(false)
      expect(commandHasShellMetasyntax('ls -la --color')).toBe(false)
    })
  })

  describe('parseShellCommandForTrust persistable 专项', () => {
    it('$(cmd) → persistable: false', () => {
      expect(parseShellCommandForTrust('echo $(pwd)', commandHasShellMetasyntax)).toMatchObject({
        persistable: false,
        hasMetasyntax: true
      })
    })

    it('简单命令 → persistable: true', () => {
      expect(parseShellCommandForTrust('git status', commandHasShellMetasyntax)).toMatchObject({
        persistable: true,
        hasMetasyntax: false,
        executable: 'git'
      })
    })

    it('签名 fallback：解析失败形态的签名输出与旧实现逐字节一致（未被改动直证——零实现改动）', () => {
      // normalizeShellSignature 在 P2/P3 期间零改动（git diff 直证），引号/空白归一化行为不变
      expect(normalizeShellSignature('echo "a b"')).toBe(JSON.stringify(['echo', 'a b']))
      expect(normalizeShellSignature("echo   'x y'")).toBe(JSON.stringify(['echo', 'x y']))
      expect(normalizeShellSignature('Git STATUS')).toBe(JSON.stringify(['Git', 'STATUS']))
      // 畸形输入不折叠为常量/空签名（§3 不变量 6：禁止等价类合并）
      expect(normalizeShellSignature('echo "unclosed')).not.toBe('')
    })
  })
})
