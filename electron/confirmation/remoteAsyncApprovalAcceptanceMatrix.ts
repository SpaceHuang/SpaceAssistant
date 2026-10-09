import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type AcceptanceMatrixReference = { file: string; testName?: string }
export type AcceptanceMatrixRow = { requirement: string; references: AcceptanceMatrixReference[] }
export type AcceptanceMatrixResult = { complete: boolean; missing: Array<{ requirement: string; reference: string }>; coveredRequirements: string[] }

const planPath = resolve(process.cwd(), 'docs/plan/remote-im-async-interaction-development-plan.md')
const repositoryRoot = process.cwd()

function parseRows(markdown: string): AcceptanceMatrixRow[] {
  const sectionStart = markdown.indexOf('### 0.2 本机测试基线')
  const sectionEnd = markdown.indexOf('## 1.', sectionStart)
  const section = markdown.slice(sectionStart, sectionEnd)
  const rows: AcceptanceMatrixRow[] = []
  for (const line of section.split('\n').filter((item) => item.startsWith('  |') && !item.includes('需求/评审验收项'))) {
    const requirement = line.split('|')[1]?.trim()
    if (!requirement || requirement === '---') continue
    const references = [...line.matchAll(/`([^`]+)`/g)].map(([, token]) => {
      const slash = token.indexOf(' / ')
      return slash < 0 ? { file: token } : { file: token.slice(0, slash), testName: token.slice(slash + 3) }
    }).filter((item) => item.file.endsWith('.test.ts') || item.file.endsWith('.test.tsx'))
    rows.push({ requirement, references })
  }
  return rows
}

function findTestNames(fileContent: string): string[] {
  return [...fileContent.matchAll(/\b(?:it|test)\s*\(\s*(['"`])([^'"`]+)\1/g)].map(([, , name]) => name)
}

export function inspectRemoteAsyncApprovalAcceptanceMatrix(input: { rows?: AcceptanceMatrixRow[] } = {}): AcceptanceMatrixResult {
  const rows = input.rows ?? parseRows(readFileSync(planPath, 'utf8'))
  const missing: AcceptanceMatrixResult['missing'] = []
  const coveredRequirements: string[] = []
  for (const row of rows) {
    if (row.references.length === 0) {
      missing.push({ requirement: row.requirement, reference: 'no-local-test-reference' })
      continue
    }
    let covered = false
    for (const reference of row.references) {
      const absolute = resolve(repositoryRoot, reference.file)
      if (!existsSync(absolute)) {
        missing.push({ requirement: row.requirement, reference: `${reference.file} (file missing)` })
        continue
      }
      if (!reference.testName) {
        covered = true
        continue
      }
      const testNames = findTestNames(readFileSync(absolute, 'utf8'))
      if (testNames.includes(reference.testName)) covered = true
      else missing.push({ requirement: row.requirement, reference: `${reference.file} / ${reference.testName} (test missing)` })
    }
    if (covered) coveredRequirements.push(row.requirement)
  }
  const all = coveredRequirements.join('\n')
  const requiredTokens = ['OQ-1', 'OQ-2', 'OQ-3', 'OQ-4', 'OQ-5', 'OQ-6', 'OQ-7', 'OQ-8',
    'P1-1', 'P1-2', 'P1-3', 'P1-4', 'P1-5', 'P1-6', 'P1-7', 'G1–G4', 'G1–G4/F/G',
    'develop v0.2 §12', '历轮安全需求评审', '历轮设计/开发计划评审']
  for (const token of requiredTokens) {
    if (all.includes(token)) continue
    if (token === 'G1–G4/F/G' && (all.includes('G1–G4/F/G') || (all.includes('G1–G4') && all.includes('§15.6 F1–F4')))) continue
    missing.push({ requirement: token, reference: 'required acceptance family has no validated matrix row' })
  }
  return { complete: missing.length === 0, missing, coveredRequirements }
}
