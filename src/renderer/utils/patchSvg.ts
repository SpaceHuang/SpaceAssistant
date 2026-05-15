/** Patch raw SVG assets for inline use: theme color + viewBox for correct scaling. */
export function patchSvg(raw: string, size: number | string = '1em'): string {
  let svg = raw.replace(/fill="#09244B"/g, 'fill="currentColor"')
  if (!svg.includes('viewBox=')) {
    svg = svg.replace('<svg ', '<svg viewBox="0 0 24 24" ')
  }
  const dim = String(size)
  return svg.replace(/width="24"/, `width="${dim}"`).replace(/height="24"/, `height="${dim}"`)
}
