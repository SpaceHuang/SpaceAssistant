/**
 * 会话归属与可见性（偏差 7 整项）：sessions 的独立维度，先有谓词再有过滤。
 *
 * - ownership：会话归属（谁驱动了它）——user 桌面用户 / remote IM 远程托管 /
 *   automation 管家定时与无人值守 / internal 内部调用（不落用户会话分区）。
 * - visibility：可见性（在哪显示）——primary 用户主列表 / section 独立分区（如管家）/
 *   hidden 不可见（内部会话等）。
 */

export const SESSION_OWNERSHIPS = ['user', 'remote', 'automation', 'internal'] as const
export type SessionOwnership = (typeof SESSION_OWNERSHIPS)[number]

export const SESSION_VISIBILITIES = ['primary', 'section', 'hidden'] as const
export type SessionVisibility = (typeof SESSION_VISIBILITIES)[number]

export function isSessionOwnership(value: unknown): value is SessionOwnership {
  return typeof value === 'string' && (SESSION_OWNERSHIPS as readonly string[]).includes(value)
}

export function isSessionVisibility(value: unknown): value is SessionVisibility {
  return typeof value === 'string' && (SESSION_VISIBILITIES as readonly string[]).includes(value)
}

/** 容错归一：历史/损坏数据回退默认（user/primary），保证谓词可闭合判定。 */
export function normalizeOwnership(value: unknown): SessionOwnership {
  return isSessionOwnership(value) ? value : 'user'
}

export function normalizeVisibility(value: unknown): SessionVisibility {
  return isSessionVisibility(value) ? value : 'primary'
}

export type SessionScopeFields = {
  ownership?: SessionOwnership
  visibility?: SessionVisibility
}

/** 该不该进用户主列表：internal/hidden 永不进；section 走独立分区。 */
export function shouldAppearInPrimaryListView(session: SessionScopeFields): boolean {
  const ownership = normalizeOwnership(session.ownership)
  const visibility = normalizeVisibility(session.visibility)
  return ownership !== 'internal' && visibility !== 'hidden' && visibility !== 'section'
}

/** 该不该进跨会话搜索：internal 永不进；automation/section 进（v1：结果标注来源）。 */
export function shouldAppearInSearch(session: SessionScopeFields): boolean {
  return normalizeOwnership(session.ownership) !== 'internal'
}

/** 管家分区：automation 归属 + section 可见性。 */
export function isButlerSectionSession(session: SessionScopeFields): boolean {
  return normalizeOwnership(session.ownership) === 'automation' && normalizeVisibility(session.visibility) === 'section'
}
