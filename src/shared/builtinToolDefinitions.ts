const ARTIFACT_WRITE_INTENT_SCHEMA = {
  type: 'object',
  properties: {
    container: { type: 'string', enum: ['project', 'package', 'scratch'] },
    role: { type: 'string', enum: ['primary', 'supporting', 'reference', 'scratch'] },
    artifactId: { type: 'string' },
    packageId: { type: 'string' },
    title: { type: 'string' },
    stage: { type: 'string', enum: ['working', 'draft', 'final'] },
    requestedPath: { type: 'string' },
    pathKind: { type: 'string', enum: ['file', 'directory', 'auto'] },
    materialKind: { type: 'string', enum: ['query', 'script', 'note', 'data', 'other'] },
    temporaryReason: { type: 'string' },
    pathSource: { type: 'string' },
    pathEvidenceId: { type: 'string' },
    pathDecisionId: { type: 'string' }
  },
  oneOf: [
    {
      properties: { pathSource: { enum: ['user'] } },
      required: ['pathSource', 'pathEvidenceId'],
      not: { required: ['pathDecisionId'] }
    },
    {
      properties: { pathSource: { enum: ['project-convention'] } },
      required: ['pathSource'],
      not: { anyOf: [{ required: ['pathEvidenceId'] }, { required: ['pathDecisionId'] }] }
    },
    {
      properties: { pathSource: { enum: ['agent-default'] } },
      required: ['pathSource'],
      not: { anyOf: [{ required: ['pathEvidenceId'] }, { required: ['pathDecisionId'] }] }
    }
  ]
} as const

/** Anthropic tools 定义（与 docs/requirement/tools-requirement.md 对齐） */
export const BUILTIN_TOOL_DEFINITIONS: Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> = [
  {
    name: 'read_file',
    description:
      '读取指定文件内容（仅适用于文件，不可用于目录；查看目录请用 list_directory）。路径相对于工作目录，不可超出工作目录范围。大文件请使用 offset（1-based 起始行号）与 limit（读取行数）分段读取，避免一次返回全文。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' },
        offset: {
          type: 'integer',
          description: '起始行号（从 1 开始，含）。省略时从第 1 行开始'
        },
        limit: {
          type: 'integer',
          description: '最多读取的行数。省略时读取从 offset 到文件末尾（仍受单文件 2MB 上限约束）'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'edit_file',
    description:
      '通过字符串替换对文件进行增量编辑。保留原文件换行符格式和文件特性。适用于修改现有文件的部分内容、创建新文件（old_string 为空）、删除内容（new_string 为空）。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' },
        old_string: { type: 'string', description: '待替换的字符串（必须精确匹配，包括缩进）。空字符串表示创建新文件。' },
        new_string: { type: 'string', description: '替换后的新字符串（需与 old_string 不同）。空字符串表示删除内容。' },
        replace_all: { type: 'boolean', description: '是否全局替换（替换所有匹配项），默认 false' },
        artifact: ARTIFACT_WRITE_INTENT_SCHEMA
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'write_file',
    description:
      '将完整内容写入指定文件，完整替换文件原有内容。适用于创建新文件或完全重写文件。路径相对于工作目录，不可超出工作目录范围。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' },
        content: { type: 'string', description: '要写入的完整文件内容' },
        artifact: ARTIFACT_WRITE_INTENT_SCHEMA
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录。路径相对于工作目录，不可超出工作目录范围。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的目录路径，默认为工作目录根' }
      }
    }
  },
  {
    name: 'grep',
    description:
      '在工作目录内按正则搜索文件内容（跨平台，内置实现，不依赖系统 grep/findstr/rg）。需要行号时用 output_mode=content；限制条数用 head_limit（等同 shell 的 head）。文本搜索一律用本工具，不要在 run_shell 中写 grep、findstr、head、find 等命令。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式搜索模式' },
        path: {
          type: 'string',
          description: '搜索路径，支持相对路径（相对于工作目录）和绝对路径，默认搜索整个工作目录'
        },
        glob: { type: 'string', description: "文件名 glob 过滤模式，如 '*.ts'、'**/*.{ts,tsx}'" },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description:
            '输出模式：files_with_matches（默认）、content（含行号）、count（每文件匹配行数）'
        },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' },
        show_line_number: { type: 'boolean', description: '显示行号（仅 content 模式），默认 true' },
        context: { type: 'number', description: '匹配行前后上下文行数（仅 content 模式）' },
        multiline: { type: 'boolean', description: '多行模式，默认 false' },
        head_limit: { type: 'number', description: '最大返回条数，默认 100，0 表示不限制' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'run_script',
    description:
      '执行一段 Python 脚本代码（仅 Python）。脚本在工作目录下执行，有超时限制。执行前需用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的脚本代码' },
        timeout: { type: 'number', description: '超时时间（秒），默认 300' }
      },
      required: ['code']
    }
  },
  {
    name: 'run_shell',
    description:
      '在会话工作目录下执行 shell 命令（Windows: cmd，Unix: bash）。用于 npm、git、构建/测试等 CLI。文本搜索请用 grep 工具，勿在此执行 grep/findstr/head/find/sed/awk；Python 片段请用 run_script，飞书请用 run_lark_cli。执行前需用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令（可含 &&、||、| 等）' },
        description: { type: 'string', description: '命令用途简述（可选，≤512 字符）' },
        timeout: { type: 'number', description: '超时秒数，默认使用设置中的 shell 默认超时' }
      },
      required: ['command']
    }
  },
  {
    name: 'run_lark_cli',
    description:
      '执行飞书官方 lark-cli 命令，用于操作飞书消息、文档、日历、多维表格、邮箱等。仅允许 lark-cli 参数列表；禁止 shell 管道与重定向。',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'lark-cli 参数列表，不含可执行文件名。例：["message","send","--chat-id","oc_xxx","--text","hello"]'
        },
        timeout: { type: 'number', description: '超时秒数，默认 120' }
      },
      required: ['args']
    }
  },
  {
    name: 'read_feishu_attachment',
    description: '读取 userData/feishu-media 目录下的飞书消息附件（只读，防路径遍历）。',
    input_schema: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '相对于 feishu-media 根目录的路径' }
      },
      required: ['relativePath']
    }
  },
  {
    name: 'browser',
    description:
      '在隔离浏览器中访问网页（基于 Stagehand）。navigate 打开 URL；observe 发现可交互元素；extract 抽取页面内容；act 执行单步自然语言操作（需确认，指令须原子化）；screenshot 截图；close 关闭会话。workflow 建议：navigate → observe/extract → act。未在可信域名中的 URL 需用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'observe', 'extract', 'act', 'screenshot', 'close']
        },
        url: { type: 'string', description: 'action=navigate 且 mode=open 时必填' },
        mode: {
          type: 'string',
          enum: ['open', 'refresh', 'back', 'forward'],
          description: 'action=navigate 时，默认 open'
        },
        wait_until: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'navigate(mode=open) 的 Playwright waitUntil，默认 domcontentloaded'
        },
        instruction: {
          type: 'string',
          description: 'action=observe/extract/act 时的自然语言指令；act 须为单步原子操作'
        },
        selector: { type: 'string', description: 'action=observe/extract 可选，缩小 DOM 范围' },
        full_page: { type: 'boolean', description: 'action=screenshot，默认 false' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_detect',
    description:
      '检测 browser 工具依赖（Stagehand、Playwright、Chromium、Node）是否就绪。返回 canInitialize、primaryFailure 与各组件状态。修复网络访问依赖时优先调用；用户表示安装完成后传 force=true 重新检测。',
    input_schema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: '跳过缓存强制重新检测，默认 false'
        }
      }
    }
  },
  {
    name: 'wechat_reply',
    description:
      '向当前微信对话回复消息。仅在 source=wechat 的会话中使用。自动处理 context_token 与长文本分片。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '回复文本' },
        imagePath: { type: 'string', description: '相对 workDir 的图片路径' },
        filePath: { type: 'string', description: '相对 workDir 的文件路径' }
      },
      required: ['text']
    }
  },
  {
    name: 'wechat_send',
    description:
      '向指定微信用户 ID 主动发送消息。需要已知 userId（例如历史会话 metadata）。',
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        text: { type: 'string' },
        imagePath: { type: 'string' },
        filePath: { type: 'string' }
      },
      required: ['userId', 'text']
    }
  },
  {
    name: 'list_work_dirs',
    description:
      '列出所有已配置的工作目录，包含当前会话绑定的目录状态。仅在远程会话（飞书/微信）中可用。',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'switch_work_dir',
    description:
      '切换当前会话绑定的工作目录。仅在远程会话（飞书/微信）中可用。切换后当前会话的所有后续操作将在新目录下执行，不影响其他会话。',
    input_schema: {
      type: 'object',
      properties: {
        profile_id: {
          type: 'string',
          description: '工作目录配置的 ID（来自 list_work_dirs 的 id 字段），优先级最高'
        },
        name: {
          type: 'string',
          description: '工作目录名称，支持精确匹配或模糊匹配'
        },
        alias: {
          type: 'string',
          description: '工作目录别名，用于远程指令快捷匹配'
        }
      },
      description:
        '至少提供 profile_id、name 或 alias 中的一个。匹配优先级：profile_id > name（精确）> alias（精确）> name（模糊）'
    }
  },
  {
    name: 'switch_session',
    description:
      '将桌面端当前视图切换到指定会话，并同步该会话绑定的工作目录。仅远程会话（飞书/微信）可用。通常从 IM 出站末尾「 会话$...$ 」后缀获取 session_id。',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '目标会话 ID（UUID），通常来自 IM 出站末尾「 会话$...$ 」后缀'
        }
      },
      required: ['session_id']
    }
  }
]

export const ALL_BUILTIN_TOOL_NAMES = BUILTIN_TOOL_DEFINITIONS.map((t) => t.name)
