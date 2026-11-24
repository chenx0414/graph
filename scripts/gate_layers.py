"""Which modules the blocking gate has to test, given what a change touched.

The gate used to run every module on every change. Measured 2026-11-23: 98s, of which
`go -C app test` was 41s and `internal/graph` 17s - and neither can be broken by a change
to the other. Narrowing by module is the only narrowing that survives contact with this
repository: dependency analysis reports 17 of 17 packages for a single edit inside
`backend/internal/graph`, because every package is reachable from every other one.

The rule is deliberately conservative. Anything that cannot be placed - a new top-level
directory, a file in scripts/ - widens to every module rather than narrowing, because a
gate that skips the module a change breaks is worse than a gate that runs for two minutes.
"""

ALL_MODULES = ["app", "backend", "verification"]


def module_of(path):
    """The module a repository-relative path belongs to, or None when it is not in one."""
    for module in ALL_MODULES:
        if path == module or path.startswith(module + "/"):
            return module
    return None


def modules_to_test(changed, override=None):
    """An explicit override wins: the gate itself is tested by naming the modules it should run.

    A name that is not a module widens to all of them. "ap" is a typo, and reading it as
    "run nothing" would turn one keystroke into a gate that tests nothing at all.
    """
    if override:
        selected = [module for module in ALL_MODULES if module in override]
        return selected or list(ALL_MODULES)
    return selected_modules(changed)


def selected_modules(changed):
    """The modules whose tests a change can affect.

    An empty or unplaceable change widens to every module: "no evidence" is not "no effect".
    """
    selected = set()
    for path in changed:
        module = module_of(path.replace("\\", "/"))
        if module is None:
            return list(ALL_MODULES)
        selected.add(module)
    if not selected:
        return list(ALL_MODULES)
    # verification/ drives the built app and the daemon as a black box, so a change to either
    # can break it: once two product modules are touched, its acceptance runs too.
    if {"app", "backend"} <= selected:
        selected.add("verification")
    return [module for module in ALL_MODULES if module in selected]
