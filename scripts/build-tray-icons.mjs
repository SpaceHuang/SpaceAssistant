import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const iconRoot = path.join(root, 'res/icons')
const outDir = path.join(root, 'resources/tray')
const publicDir = path.join(root, 'public')

async function writeTrayVariant(srcPng, baseName) {
  const png32 = await sharp(srcPng).resize(32, 32).png().toBuffer()
  const png16 = await sharp(srcPng).resize(16, 16).png().toBuffer()

  // Mac/Linux tray：16x16 @1x + 32x32 @2x。Electron nativeImage.createFromPath 会按
  // @2x 命名约定自动加载 Retina；Mac 系统菜单栏高度 22px、规范图标 16x16，
  // 32x32 当作 1x 会偏大、显示不下。
  const pngPath = path.join(outDir, `${baseName}.png`)
  fs.writeFileSync(pngPath, png16)
  console.log('Wrote', pngPath)

  const png2xPath = path.join(outDir, `${baseName}@2x.png`)
  fs.writeFileSync(png2xPath, png32)
  console.log('Wrote', png2xPath)

  const icoBuffer = await pngToIco([png16, png32])
  const icoPath = path.join(outDir, `${baseName}.ico`)
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('Wrote', icoPath)
}

async function writeAppIcon(srcPng, icoPath) {
  // Windows 应用图标要求多尺寸 ICO；electron-builder 用它生成 exe/快捷方式/任务栏图标
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngBuffers = await Promise.all(
    sizes.map((s) => sharp(srcPng).resize(s, s).png().toBuffer()),
  )
  const icoBuffer = await pngToIco(pngBuffers)
  fs.mkdirSync(path.dirname(icoPath), { recursive: true })
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('Wrote', icoPath, `(${sizes.join('/')})`)
}

async function writeFavicon(srcPng) {
  fs.mkdirSync(publicDir, { recursive: true })

  const png32 = await sharp(srcPng).resize(32, 32).png().toBuffer()
  const png16 = await sharp(srcPng).resize(16, 16).png().toBuffer()

  const pngPath = path.join(publicDir, 'favicon.png')
  fs.writeFileSync(pngPath, png32)
  console.log('Wrote', pngPath)

  const icoBuffer = await pngToIco([png16, png32])
  const icoPath = path.join(publicDir, 'favicon.ico')
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('Wrote', icoPath)
}

async function main() {
  const lightSrc = path.join(iconRoot, 'sa-logo-256.png')
  const darkSrc = path.join(iconRoot, 'dark/sa-logo-dark-256.png')
  const faviconSrc = path.join(iconRoot, 'sa-logo-32.png')
  const appIconSrc = path.join(iconRoot, 'sa-logo-1024.png')

  for (const src of [lightSrc, darkSrc, faviconSrc, appIconSrc]) {
    if (!fs.existsSync(src)) {
      console.error('Source PNG not found:', src)
      process.exit(1)
    }
  }

  fs.mkdirSync(outDir, { recursive: true })

  await writeTrayVariant(lightSrc, 'tray')
  await writeTrayVariant(darkSrc, 'tray-dark')
  await writeFavicon(faviconSrc)
  await writeAppIcon(appIconSrc, path.join(iconRoot, 'sa-logo.ico'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
