/** Anthropic tools 定义（与 docs/requirement/tools-requirement.md 对齐） */
export const BUILTIN_TOOL_DEFINITIONS: Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> = [
  {
    name: 'read_file',
    description:
      '读取指定文件的完整内容。路径相对于工作目录，不可超出工作目录范围。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作目录的文件路径' }
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
        replace_all: { type: 'boolean', description: '是否全局替换（替换所有匹配项），默认 false' }
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
        content: { type: 'string', description: '要写入的完整文件内容' }
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
      '在工作目录下递归搜索匹配正则表达式的文件内容，支持多种输出模式和文件名过滤。',
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
      '执行一段 Python 脚本代码。脚本在工作目录下执行，有超时限制。执行前需用户确认。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的脚本代码' },
        timeout: { type: 'number', description: '超时时间（秒），默认 300' }
      },
      required: ['code']
    }
  }
]

export const ALL_BUILTIN_TOOL_NAMES = BUILTIN_TOOL_DEFINITIONS.map((t) => t.name)
