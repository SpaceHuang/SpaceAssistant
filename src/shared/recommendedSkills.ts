export interface RecommendedSkillEntry {
  id: string
  name: string
  description: string
  sourceUrl: string
  /** 仓库内 Skill 目录，相对解压后的仓库根目录 */
  subPath?: string
  /** 为 true 时安装 subPath 下所有含 SKILL.md 的子目录 */
  installAll?: boolean
  /** 安装完成后用于判断「已安装」状态的 Skill 名称列表 */
  expectedSkillNames: string[]
}

export const RECOMMENDED_SKILLS: RecommendedSkillEntry[] = [
  {
    id: 'superpowers',
    name: 'Superpowers',
    description:
      '面向 AI 编程助手的工作流技能合集，涵盖头脑风暴、TDD、代码审查、计划执行与调试等场景。',
    sourceUrl: 'https://github.com/obra/superpowers',
    subPath: 'skills',
    installAll: true,
    expectedSkillNames: [
      'brainstorming',
      'dispatching-parallel-agents',
      'executing-plans',
      'finishing-a-development-branch',
      'receiving-code-review',
      'requesting-code-review',
      'subagent-driven-development',
      'systematic-debugging',
      'test-driven-development',
      'using-git-worktrees',
      'using-superpowers',
      'verification-before-completion',
      'writing-plans',
      'writing-skills'
    ]
  },
  {
    id: 'guizang-social-card',
    name: '归藏社交卡片',
    description: '生成归藏风格的小红书图文、微信公众号封面与社交媒体卡片图组。',
    sourceUrl: 'https://github.com/op7418/guizang-social-card-skill',
    expectedSkillNames: ['guizang-social-card-skill']
  },
  {
    id: 'pptx-generator',
    name: 'PPTX Generator',
    description: '创建、编辑与读取 PowerPoint 演示文稿，支持 PptxGenJS 与 XML 工作流。',
    sourceUrl: 'https://github.com/MiniMax-AI/skills/tree/main/skills/pptx-generator',
    expectedSkillNames: ['pptx-generator']
  },
  {
    id: 'minimax-xlsx',
    name: 'MiniMax XLSX',
    description: '创建、读取、分析与编辑 Excel 电子表格，支持公式校验与 XML 无损编辑。',
    sourceUrl: 'https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-xlsx',
    expectedSkillNames: ['minimax-xlsx']
  },
  {
    id: 'minimax-docx',
    name: 'MiniMax DOCX',
    description: '专业 Word 文档创建、编辑与排版，支持模板套用与 OpenXML 校验。',
    sourceUrl: 'https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-docx',
    expectedSkillNames: ['minimax-docx']
  }
]

export function getRecommendedSkillAuthor(entry: RecommendedSkillEntry): string {
  const match = entry.sourceUrl.match(/github\.com\/([^/]+)/i)
  return match?.[1] ?? '—'
}

export function isRecommendedSkillInstalled(
  entry: RecommendedSkillEntry,
  installedSkillNames: ReadonlySet<string>
): boolean {
  return entry.expectedSkillNames.every((name) => installedSkillNames.has(name))
}
