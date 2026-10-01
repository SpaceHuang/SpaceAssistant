import ts from 'typescript'

export type HardcodedChineseOccurrence = {
  line: number
  text: string
}

const chinesePattern = /[\u3400-\u9fff]/

export function findHardcodedChinese(source: string, fileName: string): HardcodedChineseOccurrence[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const occurrences: HardcodedChineseOccurrence[] = []

  const visit = (node: ts.Node): void => {
    let text: string | null = null
    if (
      ts.isStringLiteralLike(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
    ) {
      text = node.text
    } else if (ts.isJsxText(node)) {
      text = node.getText(sourceFile)
    }

    if (text !== null && chinesePattern.test(text)) {
      occurrences.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        text
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return occurrences
}
