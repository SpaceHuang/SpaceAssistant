/** Model-facing explanations for host policy denials. Detailed rule IDs stay in audit events. */
const denialExplanations: Readonly<Record<string, Readonly<{ category: string; message: string }>>> = {
  'write-parent-directory-missing': {
    category: 'path-target-unavailable',
    message: '目标目录不存在，无法创建该文件；请改写到一个已存在的目录，或告知用户需要先建立该目录'
  }
}

export function explainPolicyDenial(reasonCode: string, _untrustedReason?: string): string {
  const explanation = denialExplanations[reasonCode]
  if (explanation) return `[${explanation.category}] ${explanation.message}`
  return ''
}
