import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const srcSvg = path.join(root, 'res/mingcute-icons-main/svg/part/head_ai_fill.svg')
const outDir = path.join(root, 'resources/tray')

async function main() {
  if (!fs.existsSync(srcSvg)) {
    console.error('Source SVG not found:', srcSvg)
    process.exit(1)
  }

  fs.mkdirSync(outDir, { recursive: true })

  const png32 = await sharp(srcSvg).resize(32, 32).png().toBuffer()
  const png16 = await sharp(srcSvg).resize(16, 16).png().toBuffer()

  const pngPath = path.join(outDir, 'tray.png')
  fs.writeFileSync(pngPath, png32)
  console.log('Wrote', pngPath)

  const icoBuffer = await pngToIco([png16, png32])
  const icoPath = path.join(outDir, 'tray.ico')
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('Wrote', icoPath)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
