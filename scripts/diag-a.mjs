#!/usr/bin/env node
/**
 * diag-a: 只读诊断脚本。
 *
 * 统计仓库里的测试文件数量与测试用例（声明）数量，并向 stdout 打印一行摘要。
 *
 * 约定：
 * - 只读取文件；不写入、不修改仓库里的任何内容，退出码恒为 0（除非 tests/ 不存在）。
 * - 只使用 node 内置模块（node:fs / node:path / node:url），不新增任何依赖。
 * - 测试文件口径与 vitest.config.ts 的 include 一致：tests/**\/*.test.ts。
 * - 用例口径：源码里每处 test(...) / it(...) 声明计 1 项；test.each / it.each 同样
 *   按“一条声明”计 1（展开出的行数要到运行时才知道，静态扫描不猜测；循环里运行的
 *   单个声明也只计 1）。文档里写清这条口径，避免与 `vitest list` 的运行条数对不上。
 * - 扫描前先按 JS 词法剥离注释、字符串、模板字面量与正则字面量，避免把测试夹具里
 *   “test('...')”这类字符串内容误计成真实用例；模板里的 `${...}` 表达式会被递归
 *   处理，所以嵌套模板与内嵌正则都不会破坏后续计数。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE_SUFFIX = '.test.ts';
const TESTS_DIR_NAME = 'tests';

/** 匹配一处 test/it 声明（可带 .each/.skip 等修饰），只认行首声明。 */
const TEST_DECLARATION =
  /(^|\n)[ \t]*(?:test|it)(?:\s*\.\s*(?:each|skip|only|todo|fails|concurrent|sequential|for|runIf|skipIf)\b)?\s*\(/g;

/** 模板表达式里遇到这些收尾时，前一个 token 视作“值”，其后的 `/` 是除号而非正则。 */
const VALUE_BEFORE_SLASH = /[\w$)\]}'"`]/;

/**
 * 把注释、字符串、模板字面量与正则字面量替换为空白，只留下代码骨架，
 * 使 `test(` / `it(` 这类关键字不会被夹具字符串或注释误触发。
 */
function stripCommentsAndStrings(source) {
  const length = source.length;
  const out = [];
  let index = 0;
  let lastSignificant = '';

  const skipLineComment = () => {
    while (index < length && source[index] !== '\n') index += 1;
  };

  const skipBlockComment = () => {
    index += 2;
    while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
    index += 2;
  };

  const skipString = (quote) => {
    index += 1;
    while (index < length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (char === quote) return;
    }
  };

  const skipRegex = () => {
    index += 1;
    let inCharacterClass = false;
    while (index < length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '[') inCharacterClass = true;
      else if (char === ']') inCharacterClass = false;
      else if (char === '/' && !inCharacterClass) {
        index += 1;
        return;
      } else if (char === '\n') return;
      index += 1;
    }
  };

  const skipTemplate = () => {
    index += 1;
    while (index < length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '`') {
        index += 1;
        return;
      }
      if (char === '$' && source[index + 1] === '{') {
        index += 2;
        scanCode(true, false); // ${...} 里是代码：递归扫描到配对的 }
        continue;
      }
      index += 1;
    }
  };

  /** 扫描代码区。untilBrace 为真时在消费掉配对的 `}` 后返回（模板表达式用）。 */
  function scanCode(untilBrace, emit) {
    let depth = untilBrace ? 1 : 0;
    while (index < length) {
      const char = source[index];

      if (char === '/' && source[index + 1] === '/') {
        skipLineComment();
        if (emit) out.push(' ');
        continue;
      }
      if (char === '/' && source[index + 1] === '*') {
        skipBlockComment();
        if (emit) out.push(' ');
        continue;
      }
      if (char === "'" || char === '"') {
        skipString(char);
        if (emit) out.push(' ');
        lastSignificant = '"';
        continue;
      }
      if (char === '`') {
        skipTemplate();
        if (emit) out.push(' ');
        lastSignificant = '"';
        continue;
      }
      if (char === '/' && !VALUE_BEFORE_SLASH.test(lastSignificant)) {
        skipRegex();
        if (emit) out.push(' ');
        lastSignificant = '"';
        continue;
      }
      if (untilBrace) {
        if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          index += 1;
          if (depth === 0) return;
          if (emit) out.push('}');
          continue;
        }
      }

      if (emit) out.push(char);
      if (!/\s/.test(char)) lastSignificant = char;
      index += 1;
    }
  }

  scanCode(false, true);
  return out.join('');
}

function countTestDeclarations(source) {
  let count = 0;
  for (const _match of stripCommentsAndStrings(source).matchAll(TEST_DECLARATION)) count += 1;
  return count;
}

/** 递归收集 tests/ 下所有 *.test.ts，返回仓库内的相对路径（排序后稳定）。 */
function collectTestFiles(testsDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) files.push(full);
    }
  };
  walk(testsDir);
  return files.sort();
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const testsDir = join(root, TESTS_DIR_NAME);

  const files = collectTestFiles(testsDir);
  let cases = 0;
  for (const file of files) cases += countTestDeclarations(readFileSync(file, 'utf8'));

  const shown = relative(root, testsDir).split(sep).join('/') || TESTS_DIR_NAME;
  console.log(
    `[diag-a] 测试文件 ${files.length} 个，用例 ${cases} 项（${shown}/**/*.test.ts；每个 test/it 声明计 1 项，test.each 按声明计 1）`,
  );
}

main();
