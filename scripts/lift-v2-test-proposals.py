#!/usr/bin/env python3
"""Lift old-shape test proposals onto a v2 graph definition (Issue #1, HB-297).

A one-shot migration tool for the ADR 0030 retirement: it rewrites each `propose(...)`
argument in a test file so the draft carries a v2 definition, leaving every assertion
untouched. It exists because the retirement is a 70+ file migration and a mechanical,
reviewable rewrite is safer than hand-editing each one.

It lives in the repo rather than a scratch directory because this migration takes several
sessions, and a tool that only survives in /tmp is a tool the next session has to
rediscover. Delete this file once the migration is done.

Only setup is rewritten. The assertions are the evidence that shared infrastructure still
works; replacing them would replace that evidence with fresh claims of our own making.

Three call shapes are handled, because all three occur in the suite:

    propose({ ...nodes }, 'id')                  inline object literal   (pass 1)
    propose(spec, 'id')                          a variable              (pass 2)
    propose(graph({ ... }), 'id')                a factory call          (pass 3)

The third shape was missed at first, and the cost was not obvious: the affected files were
not merely un-migrated, they failed as "old shape" with nothing visibly wrong in them.

Every rewrite is located by real bracket matching. The argument may span lines and hold
nested braces, strings and template literals, so nothing here guesses where a call ends.

    usage: python3 scripts/lift-v2-test-proposals.py <file> [<file> ...]
           python3 scripts/lift-v2-test-proposals.py --list <file-with-newline-separated-paths>
"""
import re
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = 'tests/fixtures/v2-lift.ts'


def scan_call_end(src, open_paren):
    """Index just past the `)` matching the `(` at open_paren, or None.

    Strings, template literals and both comment forms are skipped, so a `(` inside any of
    them cannot move the depth.
    """
    depth = 0
    i = open_paren
    n = len(src)
    while i < n:
        ch = src[i]
        if ch in '"\'`':
            quote = ch
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if ch == '/' and i + 1 < n and src[i + 1] == '/':
            i = src.find('\n', i)
            if i < 0:
                return None
            continue
        if ch == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            if j < 0:
                return None
            i = j + 2
            continue
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def scan_object_end(src, start):
    """Index just past the `{...}` at or after start, or None."""
    i = src.find('{', start)
    if i < 0:
        return None
    depth = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if ch in '"\'`':
            quote = ch
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if ch == '/' and i + 1 < n and src[i + 1] == '/':
            i = src.find('\n', i)
            if i < 0:
                return None
            continue
        if ch == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            if j < 0:
                return None
            i = j + 2
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def ensure_imports(src, rel):
    depth = rel.count(os.sep) - 1
    fixture_path = ('../' * depth + FIXTURE) if depth >= 0 else FIXTURE
    lines = src.split('\n')
    imports = [i for i, l in enumerate(lines) if l.startswith('import ')]
    adds = []
    if not any('v2-lift' in l for _, l in ((i, lines[i]) for i in imports)):
        adds.append("import { withLiftedDefinition } from '%s';" % fixture_path)
    need_proposal = 'Proposal' in src and not re.search(
        r"import type \{[^}]*\bProposal\b[^}]*\} from '[^']*core/types\.ts'", src)
    if need_proposal:
        for i in imports:
            m = re.match(r"import type \{([^}]*)\} from '((?:\.\./)*src/core/types\.ts)';", lines[i])
            if m and 'Proposal' not in m.group(1):
                lines[i] = "import type {%s, Proposal } from '%s';" % (m.group(1), m.group(2))
                need_proposal = False
                break
        if need_proposal:
            adds.insert(0, "import type { Proposal } from '%ssrc/core/types.ts';" % ('../' * (depth + 1)))
    if not adds:
        return src
    at = imports[-1] + 1 if imports else 0
    return '\n'.join(lines[:at] + adds + lines[at:])


LEGACY_ONLY_FIELDS = (
    'input', 'context', 'container', 'routes', 'when', 'optional', 'verifier', 'replaces', 'deliverable',
)


def legacy_fields_left_behind(path):
    """Which legacy node fields this file's proposals carry that the v2 shape cannot hold.

    Scanned from the source rather than imported from the fixture: the tool runs over files
    that are mid-rewrite, and a subprocess importing them would be a circular dependency on
    exactly the code being changed. `role` is excluded - it does not change what a node does
    under v2, so reporting it would only dilute the report.
    """
    src = open(path).read()
    found = set()
    for field in LEGACY_ONLY_FIELDS:
        if re.search(r'\b%s\s*:' % field, src):
            found.add(field)
    return sorted(found)


def migrate(path):
    rel = os.path.relpath(path, ROOT)
    src = open(path).read()
    if 'withLiftedDefinition' in src:
        return 'already-lifted'
    if '.propose(' not in src:
        return 'no-propose'

    sites = 0
    for m in reversed(list(re.finditer(r'\.propose\(', src))):
        end = scan_call_end(src, m.end() - 1)
        if end is None:
            return 'unbalanced'
        if src[max(0, m.start() - 60):m.start()].count('withLiftedDefinition('):
            continue
        arg = src[m.end():end - 1]

        # pass 3: the first argument is itself a call - `graph({ ... })`
        lead = arg.lstrip()
        off = len(arg) - len(lead)
        head = re.match(r'\(?[A-Za-z_$][\w$]*\s*\(', lead)
        if head:
            call_open = m.end() + off + lead.index('(', head.start())
            call_close = scan_call_end(src, call_open)
            if call_close is not None:
                inner = src[m.end() + off:call_close]
                src = src[:m.end()] + 'withLiftedDefinition(' + inner + ')' + src[call_close:]
                sites += 1
                continue

        first = arg.split(',')[0].strip()
        if re.fullmatch(r'[A-Za-z_$][\w$]*', first):
            src = src[:m.end()] + 'withLiftedDefinition(%s)' % first + src[m.end() + len(first):]
            sites += 1
            continue

        # pass 1: an inline object literal
        obj = scan_object_end(arg, 0)
        if obj is not None and arg[:obj].strip().startswith('{'):
            src = src[:m.end()] + 'withLiftedDefinition(%s as Proposal)' % arg[:obj].rstrip() + src[m.end() + obj:]
            sites += 1

    if not sites:
        return 'no-call-shape-matched'
    open(path, 'w').write(ensure_imports(src, rel))
    # Say what the lift could not carry. A legacy field that vanishes with no trace looks
    # exactly like a field that did not matter - `input` cost most of this migration that
    # way - so the report is part of the tool's output, not an afterthought.
    carried = legacy_fields_left_behind(path)
    return 'lifted(%d)%s' % (sites, '; dropped: ' + ', '.join(carried) if carried else '')


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--list':
        args = [a for a in open(args[1]).read().split('\n') if a.strip()]
    stats = {}
    for t in args:
        r = migrate(t if os.path.isabs(t) else os.path.join(ROOT, t))
        stats.setdefault(r.split('(')[0], []).append((t, r))
    for k in sorted(stats):
        print('%-22s %d' % (k, len(stats[k])))
        if k == 'lifted':
            for f, raw in stats[k]:
                print('      ', raw, os.path.relpath(f, ROOT))
        for f, raw in stats[k]:
            if k != 'lifted':
                print('      ', os.path.relpath(f, ROOT))