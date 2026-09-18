import { describe, expect, it } from 'vitest'
import { getBundledSecurityApprovalSkill, SECURITY_APPROVAL_SKILL_NAME } from './securityApprovalSkill'

describe('securityApprovalSkill（I2：裁决标准唯一）', () => {
  it('loads bundled skill，name=security-approval', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.meta.name).toBe(SECURITY_APPROVAL_SKILL_NAME)
    expect(skill.scope).toBe('builtin')
  })

  it('裁决标准写死「用户不盯着也不会出问题」，输出限定两态 JSON', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.content).toMatch(/不盯着/)
    expect(skill.content).toMatch(/approve/)
    expect(skill.content).toMatch(/deny/)
    // 无中间态：禁止「需要更多信息」类输出
    expect(skill.content).toMatch(/只有两种输出|没有第三种|不允许/)
  })

  it('多次获取返回同一实例（标准唯一）', () => {
    expect(getBundledSecurityApprovalSkill()).toBe(getBundledSecurityApprovalSkill())
  })

  it('Skill v2 双维裁决：先评风险与授权、按阈值矩阵推导结论（对比分析 §4-A）', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.meta.version).toBe('2.0.0')
    expect(skill.content).toMatch(/riskLevel/)
    expect(skill.content).toMatch(/authorization/)
    // 推导顺序要求：先评风险，再评授权，最后推导结论
    expect(skill.content).toMatch(/先评.*风险/)
    expect(skill.content).toMatch(/再评.*授权|再评 authorization/)
    // 阈值矩阵：critical 无条件拒绝；high 需授权 ≥ medium
    expect(skill.content).toMatch(/critical/)
    expect(skill.content).toMatch(/无条件.*拒|拒.*无条件/)
    expect(skill.content).toMatch(/medium/)
  })

  it('Skill v2 防误拒节：存在平衡条款，不因规模/工作目录之外/删除单个文件一票否决（对比分析 §4-B）', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.content).toMatch(/防误拒/)
    expect(skill.content).toMatch(/不单独构成/)
    // 变量/展开需解析后再判断（遮蔽 HOME/PATH 视为高危）
    expect(skill.content).toMatch(/解析.*(目标|展开)|展开.*解析/)
    // 工具性动作原则：已授权任务范围内、可逆、无外发/凭据成分的常规写与执行可放行
    expect(skill.content).toMatch(/工具性动作|常规写与执行/)
  })

  it('Skill v2 注入举证标准：双重肯定证据才得以注入为由 deny（对比分析 §4-C）', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.content).toMatch(/同时满足/)
    expect(skill.content).toMatch(/任务无关/)
    expect(skill.content).toMatch(/指使/)
    // 疑似注入不改变证据的事实价值
    expect(skill.content).toMatch(/实现细节/)
  })

  it('Skill v2 automation 授权上限：无人场景 authorization 只能输出 unknown 或 low', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.content).toMatch(/unknown 或 low/)
  })

  it('Skill v2 输出合同与解析器同文件锚定：riskLevel/authorization 枚举与解析器一致（对比分析 §4-E）', () => {
    const skill = getBundledSecurityApprovalSkill()
    // 输出合同 JSON 键与 parseApprovalVerdict 接受的键一致
    expect(skill.content).toMatch(/"riskLevel"\s*:/)
    expect(skill.content).toMatch(/"authorization"\s*:/)
  })
})
