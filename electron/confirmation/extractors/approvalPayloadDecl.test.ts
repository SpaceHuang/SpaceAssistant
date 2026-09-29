import { describe, expect, it } from 'vitest'

import {
  approvalPayloadDeclForMcp,
  assertApprovalPayloadComplete,
} from './approvalPayloadDecl'

describe('approvalPayloadDeclForMcp', () => {
  it('inputSchema.required 数组 → 声明', () => {
    const decl = approvalPayloadDeclForMcp({
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    })
    expect(decl).toEqual({ required: ['url'] })
  })

  it('无 required 字段的 schema → undefined（未声明，与「声明为空」可区分）', () => {
    expect(approvalPayloadDeclForMcp({ type: 'object' })).toBeUndefined()
    expect(approvalPayloadDeclForMcp(undefined)).toBeUndefined()
  })
})

describe('assertApprovalPayloadComplete（R3 载荷完整性）', () => {
  it('必需字段齐备 → ok', () => {
    const r = assertApprovalPayloadComplete({ required: ['url'] }, { url: 'https://x', max_length: 1 })
    expect(r).toEqual({ ok: true, declared: true })
  })

  it('缺必需字段 → ok:false + missing 清单（文案不得表述为「调用参数缺失」）', () => {
    const r = assertApprovalPayloadComplete({ required: ['url'] }, { max_length: 1 })
    expect(r).toEqual({ ok: false, missing: ['url'], declared: true })
  })

  it('未声明（decl undefined）→ ok:true + declared:false（不误报）', () => {
    expect(assertApprovalPayloadComplete(undefined, {})).toEqual({ ok: true, declared: false })
  })

  it('声明为空清单（无安全相关性）→ ok + declared:true', () => {
    expect(assertApprovalPayloadComplete({ required: [] }, {})).toEqual({ ok: true, declared: true })
  })
})
