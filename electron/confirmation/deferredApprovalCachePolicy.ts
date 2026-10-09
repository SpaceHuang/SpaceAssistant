/** Ordinary deferred approval only resumes the bound invocation; it never grants reusable trust. */
export function deferredApprovalCachePolicy(_input: {
  lane: 'desktop' | 'wechat' | 'feishu' | 'automation'
  verdict: 'approve' | 'deny' | 'locked' | 'critical'
  actionClass: 'read' | 'write' | 'execute' | 'outbound'
}): { allowed: false; reason: 'deferred-approval-never-writes-memory' } {
  return { allowed: false, reason: 'deferred-approval-never-writes-memory' }
}
