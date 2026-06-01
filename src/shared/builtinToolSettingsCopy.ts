import { ALL_BUILTIN_TOOL_NAMES } from './builtinToolDefinitions'

export type BuiltinToolSettingsCopy = {
  /** 设置页展示名（用户向） */
  displayName: string
  /** 工具用途（用户向，一行） */
  summary: string
  /** 关闭后的影响（用户向，一行） */
  disabledHint: string
}

export const BUILTIN_TOOL_SETTINGS_COPY: Record<string, BuiltinToolSettingsCopy> = {
  read_file: {
    displayName: '读取文件',
    summary: '读取工作目录内的文件内容。',
    disabledHint: '关闭后 Agent 无法查看文件，只能根据已有对话内容回答。'
  },
  edit_file: {
    displayName: '编辑文件',
    summary: '按片段修改已有文件（查找替换式编辑）。',
    disabledHint: '关闭后 Agent 无法用差异方式改文件，整文件重写也会受限。'
  },
  write_file: {
    displayName: '写入文件',
    summary: '创建新文件或整文件覆盖写入。',
    disabledHint: '关闭后 Agent 无法新建或完整重写文件。'
  },
  list_directory: {
    displayName: '浏览目录',
    summary: '列出目录下的文件和子文件夹。',
    disabledHint: '关闭后 Agent 无法浏览项目目录结构。'
  },
  grep: {
    displayName: '搜索文件内容',
    summary: '在工作目录内按关键词或正则搜索文件内容。',
    disabledHint: '关闭后 Agent 无法全文检索代码或文本。'
  },
  run_script: {
    displayName: '运行脚本',
    summary: '运行 Python 脚本（执行前需你确认）。',
    disabledHint: '关闭后 Agent 无法执行 Python 脚本。'
  },
  run_shell: {
    displayName: 'Shell 命令',
    summary: '在会话工作目录下执行 shell 命令（执行前需你确认）。',
    disabledHint: '关闭后 Agent 无法代为运行 npm、git 等 CLI 命令。'
  },
  run_lark_cli: {
    displayName: '飞书 CLI',
    summary: '调用飞书 lark-cli，操作消息、文档、日历等。',
    disabledHint: '关闭后 Agent 无法通过飞书 CLI 读写飞书资源。'
  },
  read_feishu_attachment: {
    displayName: '读取飞书附件',
    summary: '读取飞书消息中的附件文件（只读）。',
    disabledHint: '关闭后 Agent 无法打开飞书附件内容。'
  },
  browser: {
    displayName: '网络访问',
    summary: '在隔离浏览器中打开网页、读取页面并执行点击等操作。',
    disabledHint: '关闭后 Agent 无法访问网页或自动化浏览器。'
  },
  browser_detect: {
    displayName: '浏览器依赖检测',
    summary: '检测网络访问（browser）所需的 Stagehand、Playwright、Chromium 依赖是否就绪。',
    disabledHint: '关闭后 Agent 无法在对话中自动检测浏览器依赖状态。'
  }
}

export function getBuiltinToolSettingsCopy(name: string): BuiltinToolSettingsCopy {
  return (
    BUILTIN_TOOL_SETTINGS_COPY[name] ?? {
      displayName: name,
      summary: '',
      disabledHint: '关闭后 Agent 在对话中无法调用此工具。'
    }
  )
}

/** 每个内置工具都应有设置页说明文案 */
export function assertBuiltinToolSettingsCopyComplete(): void {
  for (const name of ALL_BUILTIN_TOOL_NAMES) {
    const copy = BUILTIN_TOOL_SETTINGS_COPY[name]
    if (!copy?.summary || !copy.displayName) {
      throw new Error(`缺少工具设置说明：${name}`)
    }
  }
}

assertBuiltinToolSettingsCopyComplete()
