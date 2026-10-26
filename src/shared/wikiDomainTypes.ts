export type WikiCategoryStatus = 'active' | 'deprecated'

export interface WikiCategory {
  id: string
  name: string
  description: string
  status: WikiCategoryStatus
  allowedParentCategoryIds?: string[]
}

export interface WikiSchemaDiagnostic {
  code: string
  message: string
  line: number
  categoryId?: string
}

export type WikiSchemaParseResult =
  | { valid: true; formatVersion: 1; categories: WikiCategory[]; rules: string; diagnostics: [] }
  | { valid: false; formatVersion?: undefined; categories: []; rules: string; diagnostics: WikiSchemaDiagnostic[] }
