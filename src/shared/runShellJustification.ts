/** Keep user-authored line breaks while removing terminal/control characters from review surfaces. */
export function runShellJustificationForDisplay(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}
