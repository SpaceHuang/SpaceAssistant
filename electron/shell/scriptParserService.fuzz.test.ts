// P0-T5：畸形输入 fuzz 回归。
// 确定性伪随机（mulberry32 固定种子）对三语言各生成 ≥500 份畸形/截断/二进制噪声输入，
// 断言三条不变量：parse 不抛未捕获异常、单份 < 1s、返回值必为 ParseOutcome 两种形态之一。
import {
  scriptParserService,
  resetScriptParserServiceForTests,
  type ParseOutcome,
  type ScriptParserLanguage
} from './scriptParserService'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x736f646b // 固定种子：失败可复现

// 各语言基础样本：截断/拼接/嵌套变异的素材
const BASE_SAMPLES: Record<ScriptParserLanguage, string[]> = {
  python: [
    'import os\nimport sys\n\ndef f(a, b=1, *args, **kwargs):\n    return os.path.join(a, str(b))\n',
    'class A:\n    @property\n    def x(self):\n        return {"k": [1, 2, {"n": (3, 4)}]}\n\nprint(A().x)\n',
    'async def main():\n    async with open("f") as fh:\n        data = fh.read()\n    return f"{data!r:>10}"\n',
    'try:\n    x = lambda y: y + 1\nexcept Exception as e:\n    raise ValueError(str(e)) from e\nfinally:\n    del x\n',
    'result = [x * 2 for x in range(10) if x % 3 == 0]\nresult[1:2] = (3, 4)\nvalue = result[-1] if result else None\n'
  ],
  bash: [
    'curl -fsSL "https://example.com/x.sh" | bash -s -- --flag\n',
    'for f in *.txt; do\n  if [ -f "$f" ]; then\n    mv "$f" "${f%.txt}.bak" && echo done || exit 1\n  fi\ndone\n',
    'FOO=$(echo hello | tr a-z A-Z)\ncat <<EOF > /tmp/out\n$FOO\n`date`\nEOF\n',
    'case "$1" in\n  start) echo starting ;;\n  stop) echo stopping ;;\n  *) echo usage >&2 ; exit 2 ;;\nesac\n',
    "find . -name '*.log' -print0 | xargs -0 -I{} sh -c 'echo {}; rm -f {}'; echo $? > /tmp/rc\n"
  ],
  powershell: [
    '$ErrorActionPreference = "Stop"\nGet-ChildItem -Path . -Filter *.log | ForEach-Object { $_.FullName }\n',
    'function Get-Stuff {\n  param([string]$Name = "x", [int]$Count = 3)\n  1..$Count | ForEach-Object { "$Name-$_" }\n}\nGet-Stuff -Name y\n',
    '$list = @(1, 2, 3)\nforeach ($item in $list) {\n  if ($item -gt 1) { Write-Output "big: $item" } else { Write-Output "small: $item" }\n}\n',
    '$hash = @{ a = 1; b = @{ c = "d" } }\n$hash.b.c | Out-File -FilePath ./out.txt -Encoding utf8\n',
    'try { throw "boom" } catch { Write-Warning $_.Exception.Message } finally { Write-Output done }\n'
  ]
}

function isParseOutcome(value: unknown): value is ParseOutcome {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.ok === true) return typeof (v as { tree?: unknown }).tree === 'object'
  if (v.ok === false) return v.reason === 'not_initialized' || v.reason === 'parse_error'
  return false
}

type MutationKind = 'truncate' | 'splice' | 'noise-bytes' | 'unbalanced' | 'unicode' | 'control-chars'

function mutateInput(rand: () => number, bases: string[]): string {
  const kinds: MutationKind[] = ['truncate', 'splice', 'noise-bytes', 'unbalanced', 'unicode', 'control-chars']
  const kind = kinds[Math.floor(rand() * kinds.length)]
  const base = bases[Math.floor(rand() * bases.length)]
  switch (kind) {
    case 'truncate': {
      const cut = Math.floor(rand() * base.length)
      return base.slice(0, cut)
    }
    case 'splice': {
      const other = bases[Math.floor(rand() * bases.length)]
      const a = base.slice(0, Math.floor(rand() * base.length))
      const b = other.slice(Math.floor(rand() * other.length))
      return a + '\n' + b
    }
    case 'noise-bytes': {
      const len = 1 + Math.floor(rand() * 256)
      let out = ''
      for (let i = 0; i < len; i += 1) out += String.fromCharCode(Math.floor(rand() * 256))
      return rand() < 0.5 ? out : base + '\n' + out
    }
    case 'unbalanced': {
      const pairs = ['()', '[]', '{}', "''", '""']
      let out = base
      const count = 1 + Math.floor(rand() * 4)
      for (let i = 0; i < count; i += 1) {
        const p = pairs[Math.floor(rand() * pairs.length)]
        out += p[Math.floor(rand() * 2)]
      }
      return out
    }
    case 'unicode': {
      // 全角引号/全角括号/CJK 标点/替换符/不换行空格（\u 转义形态，避免源文件出现特殊字符）
      const chars = ['\u201c', '\u201d', '\u2018', '\u2019', '\uff08', '\uff09', '\u3010', '\u3011', '\u3000', '\ufffd', '\u00a0']
      let out = base
      for (let i = 0; i < 5; i += 1) out += chars[Math.floor(rand() * chars.length)]
      return out
    }
    case 'control-chars': {
      const chars = [0, 7, 8, 11, 12, 13, 27, 127]
      let out = base
      for (let i = 0; i < 5; i += 1) out += String.fromCharCode(chars[Math.floor(rand() * chars.length)])
      return out
    }
  }
}

describe('scriptParserService fuzz（畸形输入回归，P0-T5）', () => {
  beforeAll(async () => {
    resetScriptParserServiceForTests()
    await scriptParserService.ensureInitialized()
  })

  for (const language of ['python', 'bash', 'powershell'] as const) {
    it(`${language} × 500 份畸形输入：不抛异常、单份 < 1s、返回必为 ParseOutcome`, () => {
      const rand = mulberry32(SEED + language.length)
      const bases = BASE_SAMPLES[language]
      for (let i = 0; i < 500; i += 1) {
        const input = mutateInput(rand, bases)
        const started = Date.now()
        let outcome: ParseOutcome | undefined
        expect(() => {
          outcome = scriptParserService.parse(language, input)
        }).not.toThrow()
        const elapsed = Date.now() - started
        expect(outcome).toBeDefined()
        expect(isParseOutcome(outcome)).toBe(true)
        expect(elapsed).toBeLessThan(1000)
        if (outcome?.ok) outcome.tree.delete()
      }
    })
  }
})
