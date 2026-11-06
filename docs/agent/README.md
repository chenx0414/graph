# Graph Agent Documentation

This directory is Graph's read-only, source-controlled documentation for Agent self-awareness and system diagnosis. It ships with the application source and packaged app; it is not copied into `~/.graph`.

The system prompt injects only:

1. this file as the main documentation entrypoint;
2. the absolute path to this directory;
3. the examples directory;
4. the topic index and reading protocol.

Topic bodies stay out of the prompt and are read on demand.

## Start Here

- [Index and reading protocol](INDEX.md)
- [Graph overview](graph-overview.md)
- [Graph management API](graph-v2.md)
- [Execution model](execution-model.md)
- [Capabilities and tools](capabilities.md)
- [Permissions and recovery](permissions-and-recovery.md)
- [Artifacts and Git](artifacts-and-git.md)
- [Self configuration](self-configuration.md)
- [Models and providers](models-and-providers.md)
- [Provider authorization](provider-authorization.md)
- [Agent recipes](agent-recipes.md)
- [Troubleshooting](troubleshooting.md)

## Reading Rules

- Read this README or `INDEX.md` before explaining Graph internals.
- Resolve topic links relative to this directory, not the business worktree.
- For graph construction, start with [the running API](graph-v2.md) and [native examples](../design-graph-examples.md). These paths belong to the running application; a business checkout's older Graph documentation does not define this host's API.
- Read the complete relevant topic and follow references needed for the current operation. Historical reports and the full spec are optional investigation material.
- Treat live host facts as authoritative. Read `read_system_capabilities`, `inspect_graph_system`, `list_problems`, and node runs when the question concerns current state.
- Keep this tree read-only from the Agent's perspective. User-editable identity, tool guidance, and rules remain under `~/.graph/prompts`.

## Source Layout

```text
docs/agent/    read-only Agent documentation
examples/      runtime demos and acceptance fixtures
src/           Graph runtime, server, and console source
presets/       immutable bootstrap prompts and definitions
```

## Where things live

The repository was reorganised on 2026-11-08: `docs/agents` became `docs/guides`,
the old `docs/planning` tree was deleted, and `deliverables/`, `notes/`, `plans/`
and `perf/` moved to `docs/evidence/`, `docs/notes/` and `scripts/perf/`.
A path in an older document that no longer resolves is one of those moves, not a
missing feature.
