# L3 merge record (mainline `ad23dec3`)

The global main merged L3 into `rsi/rsi-c924ce66` as `ad23dec3`
(`rsi: Host-session browser launch: let E2E run Chromium outside the restricted-runtime sandbox`),
with the four files taken unchanged from `e710b928`.

## Post-merge run on the merged tip

Command, in a clean throwaway worktree on that tip (own `dist/graphd`):

```
node node_modules/vitest/vitest.mjs run tests/e2e/node-chat-auto-history.test.ts
```

```
✓ tests/e2e/node-chat-auto-history.test.ts (1 test) 7122ms
  ✓ a subagent chat opens the whole run without a load-older click 7121ms
Test Files  1 passed (1)
     Tests  1 passed (1)
  Duration  7.50s (start 18:29:46)
```

`node --run typecheck` on the same tip: exit 0.

## Post-run sweep

- `$TMPDIR/graph-host-browser-*`: 0 leftover directories.
- Browser processes leaked by the run: 0.
- The lane's own record (`e710b928`, run four times) reported the same: `1 passed (2.5s)` each
  time, 0 leftover temp dirs, 0 leaked browser processes.

## Note

The same four files also landed in local merge `bcaecd1f` of a throwaway worktree; that
worktree is deleted and `ad23dec3` is the authoritative copy.
