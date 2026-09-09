import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
function collectSourceFiles(directory) {
  const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  return entries.flatMap((entry) => {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(relative)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : []
  })
}

const checks = [
  {
    file: 'src/renderer/components/Chat/ChatView.autoCreateSession.test.tsx',
    patterns: [/claudeChatOn(?:Delta|ThinkingDelta|ToolUse|ToolProgress|ToolResult|ConfirmRequest|Done|Usage|Error)/g],
    message: 'renderer 不得保留已删除的 legacy Claude fact listener 测试夹具'
  },
  {
    file: 'electron/preload.ts',
    patterns: [/claudeChatOn(?:Delta|ThinkingDelta|Done|Usage|Error)/g],
    message: 'preload 不得重新暴露已删除的 legacy Claude fact listener'
  },
  {
    file: 'src/shared/api.ts',
    patterns: [/claudeChatOn(?:Delta|ThinkingDelta|Done|Usage|Error)/g],
    message: 'shared API 不得重新暴露已删除的 legacy Claude fact listener'
  },
  {
    file: 'electron/preload.ts',
    patterns: [/chat:(?:append-message|patch-message)/g],
    message: 'preload 不得重新暴露旧 chat mutation channel'
  },
  {
    file: 'src/shared/api.ts',
    patterns: [/chatAppendMessage|chatPatchMessage|chat:(?:append-message|patch-message)/g],
    message: 'shared API 不得重新暴露旧 chat mutation 名称'
  },
  {
    file: 'electron/appIpc.ts',
    patterns: [/['"]chat:(?:append-message|patch-message)['"]/g],
    message: 'main IPC 不得重新注册旧 chat mutation channel'
  },
  {
    file: 'electron/wechat/weChatCommandRouter.ts',
    patterns: [/appendMessage\(/g, /updateMessageContent\(/g],
    message: 'WeChat remote router 不得直接写入 message fact'
  },
  {
    file: 'electron/feishu/remoteCommandRouter.ts',
    patterns: [/appendMessage\(/g, /updateMessageContent\(/g],
    message: 'Feishu remote router 不得直接写入 message fact'
  },
  {
    file: 'electron/remote/turnExecutionAdapter.ts',
    patterns: [/appendMessage\(/g, /updateMessageContent\(/g, /safeWebContentsSend\(/g],
    message: 'remote execution adapter 不得直接写入或发送 message fact'
  },
  {
    file: 'electron/claudeStreamHandlers.ts',
    patterns: [/safeWebContentsSend\([^\n]*['"]claude-chat-(?:delta|thinking-delta|done|error|usage)['"]/g],
    message: 'Claude source 不得直接向 renderer 发送 fact event'
  },
  {
    file: 'electron/toolChatLoop.ts',
    patterns: [/safeWebContentsSend\([^\n]*['"](?:tool:(?:use|progress|result|confirm-request)|claude-chat-(?:delta|thinking-delta|done|error|usage))['"]/g],
    message: 'tool loop 不得绕过 sendLegacyFact 直接向 renderer 发送 fact event'
  },
]

for (const file of collectSourceFiles('src/renderer')) {
  checks.push({
    file,
    patterns: [
      /chatAppendMessage|chatPatchMessage|chat:(?:append-message|patch-message)/g,
      /claudeChatOn(?:Delta|ThinkingDelta|ToolUse|ToolProgress|ToolResult|ConfirmRequest|Done|Usage|Error)/g,
      /window\.api\.(?:appendMessage|updateMessageContent)\(/g
    ],
    message: 'renderer 不得绕过 Core 写入 message fact 或重新暴露 legacy fact listener'
  })
}

const failures = []
for (const check of checks) {
  const filePath = path.join(root, check.file)
  const source = fs.readFileSync(filePath, 'utf8')
  if (check.required && !check.required.test(source)) {
    failures.push(`${check.file}: ${check.message}`)
  }
  for (const pattern of check.patterns ?? []) {
    const matches = source.match(pattern)
    if (matches?.length) failures.push(`${check.file}: ${check.message}（${matches.length} 处）`)
  }
}

if (failures.length) {
  console.error('[message-fact-ownership] failed')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('[message-fact-ownership] ok')
}
