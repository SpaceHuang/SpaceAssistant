import type { PolicyRule } from '../confirmation/types'

/** Locked safeguards owned only by the isolated IM standard v3 behavior. */
export const IM_STANDARD_V3_LOCKED_RULES: PolicyRule[] = [
  {
    id: 'im-outside-write-review-materials-incomplete-deny', when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: ['write_file', 'edit_file'], signals: ['write-target-scope:outside-workdir', 'approval-review-materials:incomplete'] },
    denyClass: 'forbidden', action: 'deny', locked: true, reason: 'Incomplete outside-workdir write materials cannot be reviewed'
  },
  {
    id: 'im-shell-review-materials-incomplete-deny', when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_shell', signals: ['im-shell-review-candidate', 'approval-review-materials:incomplete'] },
    denyClass: 'forbidden', action: 'deny', locked: true, reason: 'Incomplete prepared Git query materials cannot be reviewed'
  },
  {
    id: 'im-script-review-materials-incomplete-deny', when: 'invocation',
    match: { lane: ['wechat', 'feishu'], toolName: 'run_script', signals: ['im-script-network-review-candidate:complete', 'approval-review-materials:incomplete'] },
    denyClass: 'forbidden', action: 'deny', locked: true, reason: 'Incomplete static network script materials cannot be reviewed'
  },
  {
    id: 'im-wechat-attachment-review-materials-incomplete-deny', when: 'invocation',
    match: { lane: ['wechat'], toolName: 'wechat_reply', signals: ['wechat-media-target:outside-workdir', 'wechat-media-review-materials:complete', 'approval-review-materials:incomplete'] },
    denyClass: 'forbidden', action: 'deny', locked: true, reason: 'Incomplete external WeChat attachment materials cannot be reviewed'
  },
  ...(['sensitive-file', 'system-dir'] as const).map((zone) => ({
    id: `remote-wechat-media-${zone}-outside-deny`, when: 'invocation' as const,
    match: { lane: ['wechat' as const], toolName: 'wechat_reply', signals: ['wechat-media-target:outside-workdir', `wechat-media-target-zone:${zone}`] },
    denyClass: 'forbidden' as const, action: 'deny' as const, locked: true,
    reason: 'Sensitive external attachments cannot use ordinary Agent review'
  }))
]
