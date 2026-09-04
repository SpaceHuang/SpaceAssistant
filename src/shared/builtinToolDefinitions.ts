/** Anthropic tools 定义（与 docs/requirement/tools-requirement.md 对齐） */
export const BUILTIN_TOOL_DEFINITIONS: Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> = [
  {
    name: 'read_file',
    description:
      '读取指定文件内容（仅适用于文件，不可用于目录；查看目录请用 list_directory）。路径相对于工作目录，不可超出工作目录范围。大文件须使用 offset+limit 分段读取，或使用 tail 读取末尾若干行（正序返回）；未提供 offset/limit/tail 且文件超过单次字符上限时，不返回正文前缀，仅返回体积等元数据与分段读取提示。tail 与 offset/limit 互斥。省略 limit 时单次最多返回 2000 行（且受单次字符上限约束）。路径字段名为 path（小写），请勿使用 filePath 或 file_path。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' },
        offset: {
          type: 'integer',
          description: '起始行号（从 1 开始，含，须为正整数）。省略时从第 1 行开始；不可与 tail 同时使用'
        },
        limit: {
          type: 'integer',
          description: '最多读取的行数（1～2000）。省略时从 offset 起最多读取 2000 行（且受单次字符上限约束）；不可与 tail 同时使用'
        },
        tail: {
          type: 'integer',
          description: '读取文件末尾至多 N 行（1～2000），按文件内原有顺序（正序）返回。不可与 offset/limit 同时使用'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'edit_file',
    description:
      '通过字符串替换对文件进行增量编辑。保留原文件换行符格式和文件特性。适用于修改现有文件的部分内容、创建新文件（old_string 为空）、删除内容（new_string 为空）。路径字段名为 path（小写），请勿使用 filePath 或 file_path。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' },
        old_string: { type: 'string', description: '待替换的字符串（必须精确匹配，包括缩进）。空字符串表示创建新文件。' },
        new_string: { type: 'string', description: '替换后的新字符串（需与 old_string 不同）。空字符串表示删除内容。' },
        replace_all: { type: 'boolean', description: '是否全局替换（替换所有匹配项），默认 false' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'write_file',
    description:
      '将完整内容写入指定文件，完整替换文件原有内容。适用于创建新文件或完全重写文件。路径相对于工作目录，不可超出工作目录范围。路径字段名为 path（小写），请勿使用 filePath 或 file_path。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' },
        content: { type: 'string', description: '要写入的完整文件内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录。路径相对于工作目录，不可超出工作目录范围。路径字段名为 path（小写），请勿使用 filePath 或 file_path。',
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
      '在当前工作目录范围内递归搜索文件内容。pattern 使用 ripgrep 默认正则语法。使用 output_mode 选择返回匹配文件、匹配内容或每文件匹配行数，使用 head_limit 限制结果数量。搜索文件内容时使用本工具，无需调用 shell。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '使用 ripgrep 默认正则语法的搜索模式；默认不支持 lookaround 和反向引用' },
        path: {
          type: 'string',
          description: '工作目录内要搜索的文件或目录；支持相对路径和工作目录内的绝对路径，默认搜索整个工作目录'
        },
        glob: { type: 'string', description: "使用 .gitignore 风格 glob，支持 !pattern 排除和 {ts,tsx} alternatives；显式单文件 path 不受过滤" },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description:
            '输出模式：files_with_matches（默认，只返回文件路径）、content（匹配行/块，默认含行号）、count（每文件匹配行数）'
        },
        ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' },
        show_line_number: { type: 'boolean', description: '显示行号（仅 content 模式），默认 true' },
        context: { type: 'integer', minimum: 0, maximum: 1000, description: '仅 content：匹配行前后各返回 N 行，整数 0～1000；其他模式返回参数错误' },
        multiline: { type: 'boolean', description: '仅 content：允许匹配跨行且 . 可匹配换行；其他模式返回参数错误' },
        head_limit: { type: 'integer', minimum: 0, maximum: 1000000, description: '最多返回的非空输出行数，默认 100；0 不限制行数但仍受 400 KiB 总上限约束' }
      },
      additionalProperties: false,
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

export {
  BUILTIN_TOOL_METADATA,
  getBuiltinToolMetadata
} from './builtinToolMetadata'
