import type { AppConfig } from '../src/shared/domainTypes'
import { formatToolLabel, type ToolCallLabelT } from '../src/shared/toolCallLabel'

const ZH_LABELS: Record<string, string> = {
  'tool.labels.grep.withPattern': '搜索 {{pattern}}',
  'tool.labels.grep.default': '搜索',
  'tool.labels.readFile': '读取文件',
  'tool.labels.listDirectory': '列出目录',
  'tool.labels.editFile': '编辑文件',
  'tool.labels.writeFile': '写入文件',
  'tool.labels.runScript': '运行脚本',
  'tool.labels.runShellEmpty': '运行命令',
  'tool.labels.browserDetect': '检测浏览器'
}

const EN_LABELS: Record<string, string> = {
  'tool.labels.grep.withPattern': 'Search {{pattern}}',
  'tool.labels.grep.default': 'Search',
  'tool.labels.readFile': 'Read file',
  'tool.labels.listDirectory': 'List directory',
  'tool.labels.editFile': 'Edit file',
  'tool.labels.writeFile': 'Write file',
  'tool.labels.runScript': 'Run script',
  'tool.labels.runShellEmpty': 'Run command',
  'tool.labels.browserDetect': 'Detect browser'
}

function makeT(locale: AppConfig['locale']): ToolCallLabelT {
  const labels = locale === 'en-US' ? EN_LABELS : ZH_LABELS
  return (key: string, options?: Record<string, unknown>) => {
    let s = labels[key] ?? key
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
      }
    }
    return s
  }
}

export function createToolCallLabelFormatter(locale: AppConfig['locale'] = 'zh-CN') {
  const t = makeT(locale)
  return (toolName: string, input: Record<string, unknown>) => formatToolLabel(toolName, input, t)
}

export function createRemoteProgressT(locale: AppConfig['locale'] = 'zh-CN'): (
  key: string,
  options?: Record<string, unknown>
) => string {
  const zh: Record<string, string> = {
    'streaming.thinking': '思考中',
    'streaming.inProgress': '生成中',
    'streaming.preparing': '准备中…',
    'streaming.awaitingConfirm': '等待确认：{{action}}'
  }
  const en: Record<string, string> = {
    'streaming.thinking': 'Thinking',
    'streaming.inProgress': 'Generating',
    'streaming.preparing': 'Preparing…',
    'streaming.awaitingConfirm': 'Awaiting confirmation: {{action}}'
  }
  const labels = locale === 'en-US' ? en : zh
  return (key: string, options?: Record<string, unknown>) => {
    let s = labels[key] ?? key
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
      }
    }
    return s
  }
}
