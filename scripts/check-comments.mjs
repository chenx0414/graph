import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { EXPLAIN_BUDGET_PER_FILE, TOTAL_BUDGET, compareExplanatory, scanRepo, scanText } from './comment-budget.mjs'

const langOf = (path) => (path.endsWith('.go') ? 'go' : 'ts')
const changedFiles = () => {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'backend', 'src'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}
const headContent = (path) => {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch {
    return ''
  }
}

const problems = []
const changedOnly = process.argv.includes('--changed')

for (const file of scanRepo()) {
  if (file.explanatory > EXPLAIN_BUDGET_PER_FILE) {
    problems.push(`${file.path}: ${file.explanatory} explanatory comments (limit ${EXPLAIN_BUDGET_PER_FILE})`)
  }
}

if (changedOnly) {
  for (const path of changedFiles()) {
    if (!path.endsWith('.go') && !path.endsWith('.ts') && !path.endsWith('.tsx')) continue
    if (path.endsWith('_test.go')) continue
    const lang = langOf(path)
    const before = headContent(path)
    const after = readFileSync(path, 'utf8')
    if (compareExplanatory(before, after, lang) === 'added') {
      problems.push(`${path}: this change adds explanatory comments (${scanText(before, lang).explanatory} -> ${scanText(after, lang).explanatory})`)
    }
  }
} else {
  const total = scanRepo().reduce((sum, file) => sum + file.explanatory, 0)
  if (total > TOTAL_BUDGET) problems.push(`repository: ${total} explanatory comments (limit ${TOTAL_BUDGET})`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`comment budget: ${problem}`)
  process.exit(1)
}

console.log(`comment budget: ok${changedOnly ? ' (changed files)' : ''}`)
