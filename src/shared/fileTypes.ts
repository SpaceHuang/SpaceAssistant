export const MAX_FILE_READ_SIZE = 2 * 1024 * 1024

export type FileTypeCategory = 'text' | 'markdown' | 'code' | 'html' | 'image' | 'unsupported'

const UNSUPPORTED_EXT = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.wasm',
  '.mhtml'
])

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const MARKDOWN_EXT = new Set(['.md', '.mdx', '.rst'])

const TEXT_EXT = new Set(['.txt', '.log', '.csv', '.tsv'])

const HTML_EXT = new Set(['.html', '.htm', '.xhtml'])

const CODE_EXT = new Set([
  '.css',
  '.scss',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml',
  '.sql'
])

const EXT_TO_SHIKI_LANG: Record<string, string> = {
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.ps1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.xml': 'xml',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.rst': 'markdown',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.csv': 'plaintext',
  '.tsv': 'plaintext'
}

export function getFileExtension(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  const idx = base.lastIndexOf('.')
  if (idx <= 0) return ''
  return base.slice(idx).toLowerCase()
}

export function isUnsupportedExtension(ext: string): boolean {
  return UNSUPPORTED_EXT.has(ext)
}

export function getImageMimeType(ext: string): string | null {
  return IMAGE_EXT[ext] ?? null
}

export function classifyFileType(filePath: string): FileTypeCategory {
  const ext = getFileExtension(filePath)
  if (isUnsupportedExtension(ext)) return 'unsupported'
  if (getImageMimeType(ext)) return 'image'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (HTML_EXT.has(ext)) return 'html'
  if (TEXT_EXT.has(ext)) return 'text'
  if (CODE_EXT.has(ext)) return 'code'
  return 'text'
}

export function extToShikiLang(filePath: string): string {
  const ext = getFileExtension(filePath)
  return EXT_TO_SHIKI_LANG[ext] ?? 'plaintext'
}

export function isTextLikeExtension(ext: string): boolean {
  if (!ext) return true
  if (isUnsupportedExtension(ext)) return false
  if (getImageMimeType(ext)) return false
  return true
}
