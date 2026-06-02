/** 去除 ANSI CSI / ESC 控制序列（颜色、粗体、光标等） */
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/** 去除 OSC 标题等序列：ESC ] ... BEL 或 ESC \ */
const OSC_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\x1B\][^\x07]*(?:\x07|\x1B\\)/g

/** 去除其它 C0 控制字符，保留换行与制表符 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** 单行内 \r 覆盖：保留最后一次 carriage return 之后的内容 */
function collapseCarriageReturns(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // CRLF 行尾：\r 为换行的一部分，不是同行覆盖
      if (line.endsWith('\r')) return line.slice(0, -1)
      const idx = line.lastIndexOf('\r')
      return idx >= 0 ? line.slice(idx + 1) : line
    })
    .join('\n')
}

/** 将子进程终端输出转为适合 UI 展示的纯文本（不渲染 ANSI，仅剥离控制码） */
export function normalizeTerminalOutput(text: string): string {
  if (!text) return ''
  let out = text.replace(OSC_ESCAPE, '').replace(ANSI_ESCAPE, '')
  out = collapseCarriageReturns(out)
  out = out.replace(CONTROL_CHARS, '')
  return out
}

/** plain 输出：非零退出码并入 stderr 文本，避免单独占一行 */
export function formatShellStderrDisplay(stderr: string, exitCode?: number | null): string {
  const err = normalizeTerminalOutput(stderr)
  const showExit = typeof exitCode === 'number' && exitCode !== 0
  if (!showExit) return err
  const tag = `退出码 ${exitCode}`
  return err.trim() ? `${tag}\n${err}` : tag
}
