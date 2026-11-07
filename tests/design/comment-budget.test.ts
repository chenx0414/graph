import { describe, expect, it } from 'vitest'

import {
  EXPLAIN_BUDGET_PER_FILE,
  TOTAL_BUDGET,
  compareExplanatory,
  scanRepo,
  scanText,
} from '../../scripts/comment-budget.mjs'

describe('comment budget', () => {
  it('keeps a triple-slash reference and a ts directive free of charge', () => {
    const text = [
      '/// <reference types="vite/client" />',
      '// @ts-expect-error plain-JS module',
      'const x = 1',
    ].join('\n')

    expect(scanText(text, 'ts')).toMatchObject({ directive: 2, explanatory: 0 })
  })

  it('counts an explanatory comment and keeps a machine directive free of charge', () => {
    const text = [
      '// graph:allow-large-file: the file predates the budget',
      '// re-read the row so a second settle changes nothing',
      'x := 1',
    ].join('\n')

    expect(scanText(text, 'go')).toMatchObject({ directive: 1, explanatory: 1 })
  })

  it('counts a trailing comment and ignores a slash pair inside a string', () => {
    const text = [
      'const url = "https://example.com/a//b"',
      'x := 1 // the lock is held here',
    ].join('\n')

    expect(scanText(text, 'go')).toMatchObject({ directive: 0, explanatory: 1 })
  })

  it('counts a block comment once for every line it occupies', () => {
    const text = ['/*', ' * the first line', ' * the second line', ' */', 'x := 1'].join('\n')

    expect(scanText(text, 'go').explanatory).toBeGreaterThanOrEqual(2)
  })

  it('keeps every source file inside its own budget', () => {
    const over = scanRepo().filter((file) => file.explanatory > EXPLAIN_BUDGET_PER_FILE)

    expect(over.map((file) => `${file.path}: ${file.explanatory} > ${EXPLAIN_BUDGET_PER_FILE}`)).toEqual([])
  })

  it('keeps the whole repository inside the total budget', () => {
    const total = scanRepo().reduce((sum, file) => sum + file.explanatory, 0)

    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET)
  })

  it('refuses a change that adds comments and allows one that removes them', () => {
    const before = '// one\n// two\nx := 1\n'

    expect(compareExplanatory(before, '// one\nx := 1\n', 'go')).toBe('ok')
    expect(compareExplanatory(before, '// one\n// two\n// three\nx := 1\n', 'go')).toBe('added')
  })
})
