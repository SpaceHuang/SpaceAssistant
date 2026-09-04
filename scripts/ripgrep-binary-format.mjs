export function detectBinaryArch(buffer, platform) {
  if (platform === 'darwin') {
    if (buffer.length < 8) return null
    const magic = buffer.readUInt32BE(0)
    if (magic === 0xfeedfacf) return buffer.readInt32BE(4) === 0x01000007 ? 'x64' : buffer.readInt32BE(4) === 0x0100000c ? 'arm64' : null
    if (magic === 0xcffaedfe) return buffer.readInt32LE(4) === 0x01000007 ? 'x64' : buffer.readInt32LE(4) === 0x0100000c ? 'arm64' : null
    return null
  }
  if (platform === 'win32') {
    if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return null
    const peOffset = buffer.readUInt32LE(0x3c)
    if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return null
    return buffer.readUInt16LE(peOffset + 4) === 0x8664 ? 'x64' : null
  }
  return null
}
