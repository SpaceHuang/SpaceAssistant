import type { NamespaceKeyMap } from '../renderer/i18n/types'

export type BuiltinToolI18nKeys = {
  displayName: NamespaceKeyMap['config']
  summary: NamespaceKeyMap['config']
  disabledHint: NamespaceKeyMap['config']
}

const TOOL_I18N_KEYS: Record<string, BuiltinToolI18nKeys> = {
  read_file: {
    displayName: 'tools.builtin.readFile.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.readFile.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.readFile.disabledHint' as NamespaceKeyMap['config']
  },
  edit_file: {
    displayName: 'tools.builtin.editFile.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.editFile.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.editFile.disabledHint' as NamespaceKeyMap['config']
  },
  write_file: {
    displayName: 'tools.builtin.writeFile.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.writeFile.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.writeFile.disabledHint' as NamespaceKeyMap['config']
  },
  list_directory: {
    displayName: 'tools.builtin.listDirectory.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.listDirectory.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.listDirectory.disabledHint' as NamespaceKeyMap['config']
  },
  grep: {
    displayName: 'tools.builtin.grep.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.grep.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.grep.disabledHint' as NamespaceKeyMap['config']
  },
  run_script: {
    displayName: 'tools.builtin.runScript.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.runScript.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.runScript.disabledHint' as NamespaceKeyMap['config']
  },
  run_shell: {
    displayName: 'tools.builtin.runShell.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.runShell.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.runShell.disabledHint' as NamespaceKeyMap['config']
  },
  run_lark_cli: {
    displayName: 'tools.builtin.runLarkCli.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.runLarkCli.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.runLarkCli.disabledHint' as NamespaceKeyMap['config']
  },
  read_feishu_attachment: {
    displayName: 'tools.builtin.readFeishuAttachment.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.readFeishuAttachment.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.readFeishuAttachment.disabledHint' as NamespaceKeyMap['config']
  },
  browser: {
    displayName: 'tools.builtin.browser.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.browser.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.browser.disabledHint' as NamespaceKeyMap['config']
  },
  browser_detect: {
    displayName: 'tools.builtin.browserDetect.displayName' as NamespaceKeyMap['config'],
    summary: 'tools.builtin.browserDetect.summary' as NamespaceKeyMap['config'],
    disabledHint: 'tools.builtin.browserDetect.disabledHint' as NamespaceKeyMap['config']
  }
}

const FALLBACK_DISABLED_HINT: NamespaceKeyMap['config'] = 'tools.builtin.fallbackDisabledHint'

export function getBuiltinToolI18nKeys(name: string): BuiltinToolI18nKeys {
  return (
    TOOL_I18N_KEYS[name] ?? {
      displayName: name as NamespaceKeyMap['config'],
      summary: '' as NamespaceKeyMap['config'],
      disabledHint: FALLBACK_DISABLED_HINT
    }
  )
}
