# Graph live workspace

Branch: `codex/chat-live-workspace`; base: `f33e662`.

- One CodeMirror Markdown document replaces the separate draft preview. Formatting is decorated in place; selection reveals source delimiters. The existing Markdown preference controls decorations. Source text remains the submitted payload; IME, file paste, undo, prompt history, mentions and slash commands remain owned by the composer.
- The conversation drawer renders through a body portal. Electron expands the native window by 440px (760px for the graph), preserving the original content width and restoring bounds on close. Fullscreen, maximized and insufficient display space use a full-height overlay. This is a panel within the same native window, not an always-on-top floating OS window.
- The architecture library's eight existing patterns now have selectable React Flow diagrams and node responsibilities. These are illustrative templates, not live task execution state.
- Workspace styling uses quiet navigation, compact metadata, fewer repeated labels, and consistent app branding. Detailed state remains accessible in tooltips and panel contents.
- Model selection keeps the same master instance. `selectModel` updates the instance policy; `pi-instance` reopens the existing SessionManager and passes it to `createAgentSession`. The next operation inherits existing messages/compaction context. It does not recreate uncompressed history, guarantee identical model interpretation, or transplant provider-side caches.

## Icon

Generated with the built-in imagegen tool. Source asset: `src/web/assets/graph-icon.png`; packaged icon: `build/icon.png`. `app:icons` renders the saved source and retains the existing monochrome tray assets.

Prompt: “Use case: logo-brand. Create one polished macOS app icon for Graph, a professional AI agent orchestration workspace. A simple distinctive connected-node glyph subtly forming a capital G, three or four rounded nodes and clean links, centered on an ink navy rounded-square tile. Refined electric blue and soft jade accents, restrained depth, extremely legible at 32 pixels. Generous padding. Native macOS-quality icon, minimal geometry, no text, no letters as typography, no extra symbols, no mockup, no surrounding scene. Square 1024px composition. Transparent outside the rounded square.”

## Validation

- Browser suite: 30 chat-shell cases passed before final full regression; source preview and preference, selection reveal, undo, IME Enter guard, image persistence, slash/model actions and architecture node selection exercised.
- Isolated Electron profile: 800×700 window expanded to 1240×700; renderer content stayed 800px; drawer rectangle was x=800,y=0,width=440,height=700; close restored 800×700. No production conversation or app restart involved.
- Final `node --run check`: 179 files / 1268 tests passed; type checks and awaited-assertion checks passed; tracked acceptance evidence unchanged. `git diff --check` passed.
- `app:build` completed and packaged-resource verification passed. Generated artifacts remain in the isolated worktree; nothing was deployed to the running app.
- Packaged Electron repeated the same bounds/renderer assertions successfully using a temporary profile and `--use-mock-keychain`. The local app bundle required an ad-hoc re-sign before testing; this did not re-sign the previously generated DMG.
- Ordinary packaged startup with a fresh test profile stalled after tray creation; the mock-keychain run completed. This narrows the startup issue to the credential-access/test environment but does not establish a production fix. Real-keychain first launch remains unverified; no real credentials or production profile were changed.
