import type { ITheme, ITerminalOptions } from '@xterm/xterm'

export const SHELL_TERMINAL_FONT_SIZE = 12
/** 会话导出与宽屏时的列上限 */
export const SHELL_TERMINAL_COLS = 80
/** 低于此列宽时 ANSI 进度条等易错位 */
export const SHELL_TERMINAL_MIN_COLS = 40

const SHELL_TERMINAL_FONT_FAMILY =
  'Consolas, "Cascadia Mono", "Courier New", monospace'

/** 将应用 CSS 变量映射为 xterm ITheme */
export function buildXtermThemeFromCss(): ITheme {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback

  return {
    background: pick('--sa-code-bg', '#1e1e1e'),
    foreground: pick('--sa-code-text', '#d4d4d4'),
    cursor: pick('--sa-primary', '#3794ff'),
    cursorAccent: pick('--sa-code-bg', '#1e1e1e'),
    selectionBackground: pick('--sa-selection-bg', 'rgba(55, 148, 255, 0.3)'),
    black: '#000000',
    red: pick('--sa-accent', '#f14c4c'),
    green: '#23d18b',
    yellow: '#f5f543',
    blue: '#3b8eea',
    magenta: '#d670d6',
    cyan: '#29b8db',
    white: pick('--sa-code-text', '#d4d4d4'),
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: pick('--sa-code-text', '#eeeeee')
  }
}

export function buildShellTerminalOptions(
  overrides?: Partial<ITerminalOptions> & { cols?: number; rows?: number }
): ITerminalOptions {
  return {
    cols: SHELL_TERMINAL_COLS,
    rows: 24,
    disableStdin: true,
    rightClickSelectsWord: true,
    scrollback: 5000,
    fontSize: SHELL_TERMINAL_FONT_SIZE,
    fontFamily: SHELL_TERMINAL_FONT_FAMILY,
    lineHeight: 1.2,
    theme: buildXtermThemeFromCss(),
    ...overrides
  } as ITerminalOptions
}
