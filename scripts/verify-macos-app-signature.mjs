#!/usr/bin/env node
/**
 * Verify codesign on a macOS .app (ad-hoc or Developer ID).
 * Usage: node scripts/verify-macos-app-signature.mjs /path/to/App.app
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const appPath = process.argv[2]
if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/verify-macos-app-signature.mjs <App.app>')
  process.exit(1)
}
const resolved = path.resolve(appPath)
execFileSync('codesign', ['--verify', '--deep', '--strict', resolved], { stdio: 'inherit' })
console.log('[verify-macos-app-signature] ok:', resolved)
