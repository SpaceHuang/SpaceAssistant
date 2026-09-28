import fs from 'fs'
import os from 'os'
import path from 'path'

let cached: boolean | undefined

function detect(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-capability-'))
  try {
    fs.writeFileSync(path.join(dir, 'target'), 'x')
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 进程级一次性探测当前进程能否创建 symlink。
 *
 * win32 非管理员且未开启开发者模式的进程默认无 SeCreateSymbolicLinkPrivilege，
 * fs.symlink 直接 EPERM——依赖真实 symlink 的用例在 arrange 阶段就会失败。
 * 用例应以 `it.skipIf(!canCreateSymlinks())` 保护，并在同文件用 mock 通路
 * （spyOn fs.lstat/realpath 返回 symlink 形态）覆盖同等安全语义，保证每平台都有回归锚。
 * electron 项目为 forks 单 worker，进程级缓存安全。
 */
export function canCreateSymlinks(): boolean {
  if (cached === undefined) cached = detect()
  return cached
}
