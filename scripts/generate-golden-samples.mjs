#!/usr/bin/env node
// P1-T0：生成 Python Golden 样本集（electron/shell/testdata/golden/python/*.py）。
// 两组样本（分组以「旧实现能否解析」的实测为准，录制时自动校验一致性）：
//   (a) legacy-parseable ——「现状可解析集」（禁净退化子集，§1.1-4）：自研子集解析器可解析的构造；
//   (b) previously-failed ——「原必失败集」（P1-T6 改善度量对象）：解析失败落 A-fail → ask 的构造。
// 每条样本的判定基线 .json 由 scriptGolden.test.ts 录制模式（GOLDEN_RECORD=1）在旧实现上导出。
// 幂等：重复运行按 id 重建同名文件（内容不变时哈希稳定）。
//
// 分组勘误说明（相对评估文档推测，以基线实测为准）：
//   - 自研解析器对 f-string 静态部分、单层下标、del/assert/raise 语句、链式比较、简单推导式
//     实际可「宽松解析」成功（部分内容被静默丢弃），归入 legacy-parseable；
//   - for/if 的迭代源与 test 中的列表字面量、比较表达式实为解析失败点，归入 previously-failed。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'electron', 'shell', 'testdata', 'golden', 'python')

// —— A 组：现状可解析集（legacyParsed=true 实测）——
const groupA = [
  ['a01-print-literal', 'print("hello world")\n'],
  ['a02-binop-add', 'x = 1 + 2\nprint(x)\n'],
  ['a03-print-binop-literals', 'print(1 + 2)\n'],
  ['a04-string-concat-var', 'name = "world"\nprint("hello " + name)\n'],
  ['a05-bool-none', 'flag = True\nresult = None\nprint(flag, result)\n'],
  ['a06-list-tuple', 'items = [1, 2, 3]\npair = (1, 2)\nprint(items, pair)\n'],
  ['a09-pass-only', 'pass\n'],
  ['a10-comment-only', '# just a comment\n'],
  ['a11-empty', ''],
  ['a12-os-system', 'import os\nos.system("ls")\n'],
  ['a13-subprocess-run', 'import subprocess\nsubprocess.run(["ls", "-la"])\n'],
  ['a14-pty-spawn', 'import pty\npty.spawn(["sh"])\n'],
  ['a15-os-system-alias', 'import os as o\no.system("ls")\n'],
  ['a16-from-import-system', 'from os import system\nsystem("ls")\n'],
  ['a17-from-import-as', 'from os import system as s\ns("ls")\n'],
  ['a18-os-remove', 'import os\nos.remove("/tmp/x")\n'],
  ['a19-shutil-rmtree', 'import shutil\nshutil.rmtree("/tmp/data")\n'],
  ['a20-eval-literal', 'eval("1+1")\n'],
  ['a21-exec-string', 'exec("print(1)")\n'],
  ['a22-compile', 'compile("x=1", "<s>", "exec")\n'],
  ['a23-dunder-import', '__import__("os")\n'],
  ['a24-importlib-import-module', 'import importlib\nimportlib.import_module("subprocess")\n'],
  ['a25-ctypes-cdll', 'import ctypes\nctypes.CDLL("libc.so.6")\n'],
  ['a26-socket', 'import socket\nsocket.socket()\n'],
  ['a27-urllib-urlopen', 'import urllib.request\nurllib.request.urlopen("http://example.com")\n'],
  ['a28-requests-get', 'import requests\nrequests.get("http://example.com")\n'],
  ['a29-open-absolute-write', 'open("/etc/passwd", "w")\n'],
  ['a30-open-relative-write', 'open("relative.txt", "w")\n'],
  ['a31-open-kwarg-mode', 'open("relative.txt", mode="w")\n'],
  ['a32-open-read', 'open("data.txt", "r")\n'],
  ['a33-os-chdir', 'import os\nos.chdir("subdir")\n'],
  ['a34-getattr-os', 'import os\ngetattr(os, "system")("ls")\n'],
  ['a35-getattr-dunder-import', 'getattr(__import__("os"), "system")\n'],
  ['a36-import-module-rebind-chain', 'import importlib\nmod = importlib.import_module("os")\nmod.system("ls")\n'],
  ['a37-attr-rebind-call', 'import os\ns = os.system\ns("ls")\n'],
  ['a38-builtins-eval', 'from builtins import eval\neval("1")\n'],
  ['a39-b64-decode-exec-inline', 'import base64\nexec(base64.b64decode("aW1wb3J0IG9z").decode())\n'],
  ['a40-b64-decode-exec-var', 'import base64\ndata = base64.b64decode("aW1wb3J0IG9z")\nexec(data)\n'],
  ['a41-module-rebind', 'import os\nos2 = os\nos2.system("ls")\n'],
  ['a43-open-concat-path', 'open("/tmp/" + "x.txt", "w")\n'],
  ['a44-open-single-tuple', 'open(("relative.txt",), "w")\n'],
  ['a46-kwargs-call', 'import os\nos.system(cmd="ls")\n'],
  ['a48-multi-assign-expr', 'a = 1\nb = a + 2\nc = a * b\nprint(c)\n'],
  // 以下 8 条：评估文档推测为「必失败」，实测旧解析器可宽松解析（部分静默丢内容），以实测归入本组
  ['b04-fstring-path', 'filename = "a.txt"\npath = f"/tmp/{filename}"\nprint(path)\n'],
  ['b19-subscript-read', 'items = [1, 2, 3]\nitem = items[0]\nprint(item)\n'],
  ['b22-conditional-expr', 'cond = True\nvalue = "yes" if cond else "no"\nprint(value)\n'],
  ['b23-list-comprehension', 'items = [1, 2, 3]\ndoubled = [x * 2 for x in items]\nprint(doubled)\n'],
  ['b27-del-statement', 'x = 1\ndel x\n'],
  ['b29-assert-statement', 'value = 1\nassert value == 1\n'],
  ['b30-raise-statement', 'raise ValueError("boom")\n'],
  ['b33-chained-compare', 'a = 1\nb = 2\nprint(0 < a < b)\n']
]

// —— B 组：原必失败集（legacyParsed=false 实测 → A-fail → ask）——
const groupB = [
  ['b01-dict-literal', 'config = {"debug": True, "level": 3}\nprint(config)\n'],
  ['b02-dict-empty', 'd = {}\nd["k"] = "v"\nprint(d)\n'],
  ['b03-fstring-basic', 'name = "world"\nprint(f"hello {name}")\n'],
  ['b05-with-open-read', 'with open("data.txt") as f:\n    data = f.read()\nprint(data)\n'],
  ['b06-with-open-write', 'payload = "x"\nwith open("out.txt", "w") as f:\n    f.write(payload)\n'],
  ['b07-try-except', 'try:\n    risky = 1 / 0\nexcept Exception:\n    pass\n'],
  ['b08-try-finally', 'try:\n    value = compute()\nfinally:\n    cleanup()\n'],
  ['b09-def-basic', 'def helper(x):\n    return x * 2\n\nprint(helper(3))\n'],
  ['b10-def-default-args', 'def greet(name, greeting="hi"):\n    return f"{greeting} {name}"\n\nprint(greet("a"))\n'],
  ['b11-class-basic', 'class Runner:\n    def run(self):\n        return "running"\n\nprint(Runner().run())\n'],
  ['b12-class-inheritance', 'class Base:\n    pass\n\nclass Child(Base):\n    def go(self):\n        return 1\n'],
  ['b13-decorator-staticmethod', 'class C:\n    @staticmethod\n    def s():\n        return 1\n\nprint(C.s())\n'],
  ['b14-decorator-functools', 'import functools\n\n@functools.wraps(print)\ndef wrapper(*a, **k):\n    return print(*a, **k)\n'],
  ['b15-async-def', 'import asyncio\n\nasync def main():\n    await asyncio.sleep(1)\n\nasyncio.run(main())\n'],
  ['b16-async-with', 'async def job():\n    async with open("f.txt") as fh:\n        return fh.read()\n'],
  ['b17-lambda-basic', 'f = lambda x: x + 1\nprint(f(1))\n'],
  ['b18-lambda-key', 'items = [(2, "b"), (1, "a")]\nsorted_items = sorted(items, key=lambda i: i[0])\nprint(sorted_items)\n'],
  ['b20-subscript-write', 'config = {}\nconfig["mode"] = "fast"\nprint(config["mode"])\n'],
  ['b21-slice', 'items = [1, 2, 3, 4]\nsub = items[1:3]\nprint(sub)\n'],
  ['b24-dict-comprehension', 'pairs = [("a", 1), ("b", 2)]\nmapping = {k: v for k, v in pairs}\nprint(mapping)\n'],
  ['b25-while-augassign', 'i = 0\nwhile i < 10:\n    i += 1\nprint(i)\n'],
  ['b26-return-value', 'def answer():\n    return 42\n\nprint(answer())\n'],
  ['b28-global-statement', 'counter = 0\n\ndef bump():\n    global counter\n    counter = counter + 1\n\nbump()\nprint(counter)\n'],
  ['b31-set-literal', 's = {1, 2, 3}\nprint(s)\n'],
  ['b32-star-args', 'def f(*args, **kwargs):\n    return args, kwargs\n\nprint(f(1, x=2))\n'],
  // 以下 4 条：for/if 的列表字面量迭代源、test 中比较表达式、not/and/or 组合为旧解析器实际失败点
  ['a07-for-if-nested', 'for i in [1, 2, 3]:\n    if i > 1:\n        print(i)\n'],
  ['a08-if-else', 'x = 3\nif x > 2:\n    print("big")\nelse:\n    print("small")\n'],
  ['a42-danger-in-for-if', 'import os\nfor name in ["a", "b"]:\n    if name:\n        os.system(name)\n'],
  ['a45-compare-and-unary', 'ok = not (1 < 2 and 3 != 4)\nvalue = -5\nprint(ok, value)\n'],
  // —— 包裹危险调用（改善度量的核心样本：切换后应命中对应模式而非 A-fail）——
  ['b35-def-wraps-os-system', 'import os\n\ndef run(cmd):\n    os.system(cmd)\n\nrun("ls")\n'],
  ['b36-with-wraps-open-absolute-write', 'with open("/etc/passwd", "w") as f:\n    f.write("x")\n'],
  ['b37-try-wraps-os-system', 'import os\ntry:\n    os.system("ls")\nexcept Exception:\n    pass\n'],
  ['b38-class-wraps-subprocess', 'import subprocess\n\nclass Runner:\n    def run(self):\n        return subprocess.run(["ls"])\n\nRunner().run()\n'],
  ['b39-async-wraps-requests', 'import requests\n\nasync def fetch():\n    return requests.get("http://example.com")\n'],
  ['b40-lambda-wraps-eval', 'runner = lambda code: eval(code)\nrunner("1+1")\n'],
  ['b41-fstring-wraps-network-arg', 'import os\nuser = "x"\nos.system(f"echo {user}")\n'],
  ['b42-dict-wraps-eval-value', 'actions = {"eval": eval}\nactions["eval"]("1+1")\n'],
  ['b43-socket-in-def', 'import socket\n\ndef dial():\n    s = socket.socket()\n    return s\n\ndial()\n'],
  ['b44-with-wraps-relative-write', 'with open("out-relative.txt", "w") as f:\n    f.write("ok")\n'],
  ['b45-while-loop', 'i = 0\nwhile i < 3:\n    i = i + 1\nprint(i)\n']
]

const samples = [
  ...groupA.map(([id, code]) => ({ id, code, group: 'legacy-parseable' })),
  ...groupB.map(([id, code]) => ({ id, code, group: 'previously-failed' }))
]

fs.mkdirSync(outDir, { recursive: true })
for (const { id, code } of samples) {
  fs.writeFileSync(path.join(outDir, `${id}.py`), code, 'utf8')
}
fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({ generatedBy: 'scripts/generate-golden-samples.mjs (P1-T0)', count: samples.length, samples: samples.map(({ id, group }) => ({ id, group })) }, null, 2) + '\n',
  'utf8'
)
console.log(`[generate-golden-samples] wrote ${samples.length} samples (A=${groupA.length}, B=${groupB.length}) to ${outDir}`)
