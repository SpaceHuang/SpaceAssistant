import { spawn } from 'child_process'

export async function captureGitHead(workDir: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
      windowsHide: true,
      shell: false
    })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code === 0) {
        const head = out.trim()
        resolve(head || null)
      } else {
        resolve(null)
      }
    })
  })
}
