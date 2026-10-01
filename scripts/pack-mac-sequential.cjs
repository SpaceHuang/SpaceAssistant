const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { rimrafSync } = require('rimraf')

function packMacSequential({ runBuilder, removeX64App }) {
  const x64 = runBuilder(['--mac', 'dmg', '--x64'])
  if (x64.error || x64.status !== 0) {
    throw new Error('electron-builder x64 packaging failed', { cause: x64.error })
  }

  removeX64App()

  const arm64 = runBuilder(['--mac', 'dmg', '--arm64'])
  if (arm64.error || arm64.status !== 0) {
    throw new Error('electron-builder arm64 packaging failed', { cause: arm64.error })
  }
}

module.exports = { packMacSequential }

if (require.main === module) {
  try {
    packMacSequential({
      runBuilder: (args) => spawnSync('electron-builder', args, { stdio: 'inherit' }),
      removeX64App: () => rimrafSync(path.resolve('release/mac'))
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
