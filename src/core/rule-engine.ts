import type { Json } from './types.ts';

/**
 * The module rule expression language (Issue #1 §4, §6).
 *
 * Rules are DATA, never code: this is a hand-written recursive-descent parser and
 * evaluator. There is no `eval`, no `Function`, no property access beyond a plain
 * dotted path, and no calls the definition did not spell out. A rule that would
 * need any of those is a parse error, not a silently-false guard.
 *
 * Supported forms (§4): existence (`$exists(x)` / `$missing(x)`), field references
 * (`node.field`), literals (string/number/boolean/null), comparison
 * (`== != > >= < <=`), boolean `&&`, `||`, `!` with parentheses, and emits that
 * forward a whole input (`$name`), a field (`name.field`), or construct an object.
 */

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

export interface RuleEnvironment {
  inputs: Record<string, Json>;
  /** Module state, readable from a rule through `state.<field>` when needed. */
  state: Json;
}

export interface ParsedRule {
  /** The original source, kept so a transition can report WHY it fired. */
  source: string;
  /** Input names the rule reads, so a once-rule can require them explicitly (§4). */
  referencedInputs: string[];
  evaluate(environment: RuleEnvironment): boolean;
}

export type EmitValue =
  | { kind: 'forward'; input: string }
  | { kind: 'field'; path: string }
  | { kind: 'literal'; value: Json }
  | { kind: 'object'; fields: Record<string, EmitValue> };

export interface RuleDeclaration {
  when: ParsedRule;
  emit: Record<string, EmitValue>;
  reason?: string;
}

export interface MergedOutput {
  emitted: boolean;
  outputs: Record<string, Json>;
  reasons: string[];
}

// ---- lexer ------------------------------------------------------------------

type Token =
  | { type: 'ref'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'op'; value: string }
  | { type: 'not' }
  | { type: 'and' }
  | { type: 'or' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === ' ' || char === '\t' || char === '\n') { index += 1; continue; }
    if (char === '(') { tokens.push({ type: 'lparen' }); index += 1; continue; }
    if (char === ')') { tokens.push({ type: 'rparen' }); index += 1; continue; }
    if (char === ',') { tokens.push({ type: 'comma' }); index += 1; continue; }
    if (source.startsWith('&&', index)) { tokens.push({ type: 'and' }); index += 2; continue; }
    if (source.startsWith('||', index)) { tokens.push({ type: 'or' }); index += 2; continue; }
    if (char === '!') {
      if (source[index + 1] === '=') { tokens.push({ type: 'op', value: '!=' }); index += 2; continue; }
      tokens.push({ type: 'not' }); index += 1; continue;
    }
    if (char === '=' && source[index + 1] === '=') { tokens.push({ type: 'op', value: '==' }); index += 2; continue; }
    if (char === '=') throw new RuleError('Rules compare with ==, not a single =');
    if (char === '>' || char === '<') {
      const next = source[index + 1];
      if (next === '=') { tokens.push({ type: 'op', value: `${char}=` }); index += 2; continue; }
      tokens.push({ type: 'op', value: char }); index += 1; continue;
    }
    if (char === '"' || char === "'") {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== char) { value += source[index]; index += 1; }
      if (source[index] !== char) throw new RuleError('Unterminated string literal in rule');
      index += 1;
      tokens.push({ type: 'string', value }); continue;
    }
    if (/[0-9]/.test(char)) {
      let value = '';
      while (index < source.length && /[0-9.]/.test(source[index]!)) { value += source[index]; index += 1; }
      const number = Number(value);
      if (!Number.isFinite(number)) throw new RuleError(`Invalid number literal ${value}`);
      tokens.push({ type: 'number', value: number }); continue;
    }
    if (IDENT_START.test(char)) {
      let value = '';
      while (index < source.length && (IDENT_PART.test(source[index]!) || source[index] === '.')) { value += source[index]; index += 1; }
      // Reserved keywords are the only words with meaning; everything else is a reference.
      if (value === 'true' || value === 'false') { tokens.push({ type: 'bool', value: value === 'true' }); continue; }
      if (value === 'null') { tokens.push({ type: 'null' }); continue; }
      tokens.push({ type: 'ref', value }); continue;
    }
    throw new RuleError(`Unexpected character ${JSON.stringify(char)} in rule`);
  }
  return tokens;
}

// ---- parser -----------------------------------------------------------------

type Node =
  | { kind: 'literal'; value: Json }
  | { kind: 'ref'; path: string[] }
  | { kind: 'exists'; input: string; negated: boolean }
  | { kind: 'not'; inner: Node }
  | { kind: 'and' | 'or'; left: Node; right: Node }
  | { kind: 'compare'; op: string; left: Node; right: Node };

class Parser {
  private position = 0;
  private readonly refs = new Set<string>();
  private readonly tokens: Token[];
  private readonly source: string;
  constructor(tokens: Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
  }

  parse(): { node: Node; refs: string[] } {
    const node = this.parseOr();
    if (this.position !== this.tokens.length) throw new RuleError(`Unexpected trailing tokens in rule ${JSON.stringify(this.source)}`);
    return { node, refs: [...this.refs] };
  }

  private peek(): Token | undefined { return this.tokens[this.position]; }
  private next(): Token { const token = this.tokens[this.position]; if (!token) throw new RuleError(`Rule ended early: ${JSON.stringify(this.source)}`); this.position += 1; return token; }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek()?.type === 'or') { this.next(); left = { kind: 'or', left, right: this.parseAnd() }; }
    return left;
  }
  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.peek()?.type === 'and') { this.next(); left = { kind: 'and', left, right: this.parseNot() }; }
    return left;
  }
  private parseNot(): Node {
    if (this.peek()?.type === 'not') { this.next(); return { kind: 'not', inner: this.parseNot() }; }
    return this.parseCompare();
  }
  private parseCompare(): Node {
    const left = this.parsePrimary();
    const token = this.peek();
    if (token?.type === 'op') { this.next(); return { kind: 'compare', op: token.value, left, right: this.parsePrimary() }; }
    return left;
  }
  private parsePrimary(): Node {
    const token = this.next();
    if (token.type === 'lparen') {
      const inner = this.parseOr();
      const close = this.next();
      if (close.type !== 'rparen') throw new RuleError('Missing ) in rule');
      return inner;
    }
    if (token.type === 'string') return { kind: 'literal', value: token.value };
    if (token.type === 'number') return { kind: 'literal', value: token.value };
    if (token.type === 'bool') return { kind: 'literal', value: token.value };
    if (token.type === 'null') return { kind: 'literal', value: null };
    if (token.type === 'ref') {
      const callMatch = /^\$?(exists|missing)$/.exec(token.value);
      if (callMatch) {
        // `$exists(x)` / `$missing(x)` — the only calls the language has.
        const open = this.next();
        if (open.type !== 'lparen') throw new RuleError(`${token.value} must be called with ( )`);
        const arg = this.next();
        if (arg.type !== 'ref') throw new RuleError(`${token.value} expects an input name`);
        const close = this.next();
        if (close.type !== 'rparen') throw new RuleError(`Missing ) after ${token.value}`);
        const input = arg.value.split('.')[0]!;
        this.refs.add(input);
        return { kind: 'exists', input, negated: callMatch[1] === 'missing' };
      }
      const path = token.value.split('.');
      this.refs.add(path[0]!);
      return { kind: 'ref', path };
    }
    throw new RuleError(`Unexpected token in rule ${JSON.stringify(this.source)}`);
  }
}

const normalise = (value: Json): Json => value;

function readPath(path: string[], environment: RuleEnvironment): { found: boolean; value: Json } {
  let current: unknown = path[0] === 'state' ? environment.state : environment.inputs[path[0]!];
  if (path[0] !== 'state' && !(path[0]! in environment.inputs)) return { found: false, value: null };
  for (let index = 1; index < path.length; index += 1) {
    if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) return { found: false, value: null };
    const key = path[index]!;
    if (!(key in (current as Record<string, unknown>))) return { found: false, value: null };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: normalise((current ?? null) as Json) };
}

function evaluateNode(node: Node, environment: RuleEnvironment): Json | undefined {
  switch (node.kind) {
    case 'literal': return node.value;
    case 'ref': return readPath(node.path, environment).value;
    case 'exists': {
      if (node.input === 'state') return node.negated ? environment.state === undefined : environment.state !== undefined;
      const present = node.input in environment.inputs;
      return node.negated ? !present : present;
    }
    case 'not': return !truthy(evaluateNode(node.inner, environment));
    case 'and': return truthy(evaluateNode(node.left, environment)) && truthy(evaluateNode(node.right, environment));
    case 'or': return truthy(evaluateNode(node.left, environment)) || truthy(evaluateNode(node.right, environment));
    case 'compare': {
      const left = evaluateNode(node.left, environment);
      const right = evaluateNode(node.right, environment);
      return compare(node.op, left, right);
    }
  }
}

const truthy = (value: Json | undefined): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

function compare(op: string, left: Json | undefined, right: Json | undefined): boolean {
  if (op === '==') return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  if (op === '!=') return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
  type Ordered = string | number;
  const understand = (value: Json | undefined): Ordered | undefined =>
    typeof value === 'number' || typeof value === 'string' ? value : undefined;
  // A missing reference is not comparable: the comparison is false, never a coerced win.
  if (left === undefined || right === undefined) return false;
  const a = understand(left); const b = understand(right);
  if (a === undefined || b === undefined) return false;
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  throw new RuleError(`Unsupported comparison ${op}`);
}

/** Parse a rule expression into an evaluable form. Never `eval`s; a defect is a RuleError. */
export function parseRule(source: string): ParsedRule {
  if (typeof source !== 'string' || !source.trim()) throw new RuleError('A rule requires a nonempty expression');
  const { node, refs } = new Parser(tokenize(source), source).parse();
  return {
    source,
    referencedInputs: refs.filter(name => name !== 'state'),
    evaluate: environment => truthy(evaluateNode(node, environment)),
  };
}

/** Convenience for tests and callers that hold a parsed rule. */
export function evaluateRule(rule: ParsedRule, environment: RuleEnvironment): boolean {
  return rule.evaluate(environment);
}

/** Resolve an emit value against the environment. */
export function resolveEmit(value: EmitValue, environment: RuleEnvironment): Json {
  switch (value.kind) {
    case 'literal': return value.value;
    case 'forward': return environment.inputs[value.input] ?? null;
    case 'field': {
      const read = readPath(value.path.split('.'), environment);
      return read.found ? read.value : null;
    }
    case 'object': {
      const out: Record<string, Json> = {};
      for (const [key, child] of Object.entries(value.fields)) out[key] = resolveEmit(child, environment);
      return out;
    }
  }
}

/**
 * Translate a definition's `emit` map (JSON, §4) into typed emit values.
 * The definition syntax mirrors the rule language: `"$review"` forwards a whole
 * input, `"review.reason"` reads one field, `{...}` builds an object, and any
 * other JSON literal is used as-is.
 */
export function parseEmit(source: Record<string, Json>): Record<string, EmitValue> {
  const out: Record<string, EmitValue> = {};
  for (const [port, value] of Object.entries(source)) out[port] = parseEmitValue(value);
  return out;
}

function parseEmitValue(value: Json): EmitValue {
  if (typeof value === 'string') {
    if (value.startsWith('$')) return { kind: 'forward', input: value.slice(1) };
    // A bare dotted word is a field reference; anything else is a literal string.
    if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/.test(value)) return { kind: 'field', path: value };
    return { kind: 'literal', value };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const fields: Record<string, EmitValue> = {};
    for (const [key, child] of Object.entries(value)) fields[key] = parseEmitValue(child as Json);
    return { kind: 'object', fields };
  }
  return { kind: 'literal', value };
}

/**
 * Run every matching rule and merge its outputs in declaration order (§4).
 *
 * Two rules that emit the SAME output would make the result depend on rule order
 * for a single port — ambiguous — so that is refused with the port named, whether
 * or not both fire on this input.
 */
export function mergeRuleOutputs(rules: RuleDeclaration[], environment: RuleEnvironment): MergedOutput {
  const claimed = new Map<string, number>();
  for (const [index, rule] of rules.entries()) {
    for (const port of Object.keys(rule.emit)) {
      const prior = claimed.get(port);
      if (prior !== undefined) {
        throw new RuleError(`Rules ${prior} and ${index} both emit output ${port}; the same output may only be claimed once`);
      }
      claimed.set(port, index);
    }
  }
  const outputs: Record<string, Json> = {};
  const reasons: string[] = [];
  let emitted = false;
  for (const rule of rules) {
    if (!rule.when.evaluate(environment)) continue;
    emitted = true;
    reasons.push(rule.reason ?? rule.when.source);
    for (const [port, value] of Object.entries(rule.emit)) outputs[port] = resolveEmit(value, environment);
  }
  return { emitted, outputs, reasons };
}
