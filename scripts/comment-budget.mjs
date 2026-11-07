import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const EXPLAIN_BUDGET_PER_FILE = 8
export const TOTAL_BUDGET = 40

const DIRECTIVE = /^(?:graph:|go:|@ts-|eslint|nolint|prettier|\+build|<reference)/

const SOURCES = [
  { root: 'backend', extension: '.go', lang: 'go' },
  { root: 'src', extension: '.ts', lang: 'ts' },
  { root: 'src', extension: '.tsx', lang: 'ts' },
]

function walk(dir, extension, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, extension, out)
    else if (entry.endsWith(extension)) out.push(path)
  }
  return out
}

function commentBody(text) {
  return text
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\s*\*/gm, '')
    .replace(/^\/+/, '')
    .trim()
}

export function isDirective(text) {
  return DIRECTIVE.test(commentBody(text))
}

export function scanText(text, lang) {
  let directive = 0
  let explanatory = 0
  let quote = null
  let blockLine = -1
  let body = ''
  let line = 0
  const backtick = lang === 'go' || lang === 'ts'

  const count = (span) => {
    if (isDirective(span)) directive += 1
    else explanatory += 1
  }

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    const next = text[index + 1]

    if (quote) {
      if (ch === '\\' && quote !== '`') index += 1
      else if (ch === quote) quote = null
      else if (ch === '\n' && quote !== '`') quote = null
      continue
    }

    if (blockLine >= 0) {
      if (ch === '*' && next === '/') {
        body += '*/'
        const height = line - blockLine + 1
        if (isDirective(body)) directive += height
        else explanatory += height
        blockLine = -1
        body = ''
        index += 1
        continue
      }
      if (ch === '\n') line += 1
      body += ch
      continue
    }

    if (ch === '/' && next === '/') {
      let end = index
      while (end < text.length && text[end] !== '\n') end += 1
      count(text.slice(index, end))
      index = end - 1
      continue
    }

    if (ch === '/' && next === '*') {
      blockLine = line
      body = ''
      index += 1
      continue
    }

    if (ch === '\n') {
      line += 1
      continue
    }

    if (ch === '"' || ch === "'" || (backtick && ch === '`')) quote = ch
  }

  if (blockLine >= 0) {
    const height = line - blockLine + 1
    if (isDirective(body)) directive += height
    else explanatory += height
  }

  return { directive, explanatory, lines: text.split('\n').length }
}

export function scanRepo(root = process.cwd()) {
  const files = []
  for (const source of SOURCES) {
    for (const path of walk(join(root, source.root), source.extension, [])) {
      if (path.endsWith('_test.go')) continue
      const result = scanText(readFileSync(path, 'utf8'), source.lang)
      files.push({
        path: relative(root, path).split('\\').join('/'),
        directive: result.directive,
        explanatory: result.explanatory,
      })
    }
  }
  return files.sort((left, right) => right.explanatory - left.explanatory)
}

export function compareExplanatory(before, after, lang) {
  return scanText(after, lang).explanatory > scanText(before, lang).explanatory ? 'added' : 'ok'
}
