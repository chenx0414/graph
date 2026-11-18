#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="${1:-$REPO_ROOT/app/build/darwin-arm64/Graph.app/Contents/MacOS/Graph}"

if [ ! -f "$BINARY" ]; then
  echo "verify-bundle-selfcontained: no packaged binary at $BINARY" >&2
  echo "build it first: go -C backend run ./cmd/graphbuild app" >&2
  exit 1
fi

echo "binary: $BINARY"
echo "linked libraries:"
otool -L "$BINARY" | tail -n +2 | sed 's/^/  /'
if otool -L "$BINARY" | tail -n +2 | grep -vqE '/usr/lib/|/System/'; then
  echo "FAIL: the binary links a library outside the system paths" >&2
  exit 1
fi
echo "ok: only system libraries are linked"

SANDBOX="$(mktemp -d)"
cleanup() {
  if [ -n "${DAEMON_PID:-}" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

mkdir -p "$SANDBOX/home" "$SANDBOX/cwd" "$SANDBOX/state" "$SANDBOX/graph-home"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

cd "$SANDBOX/cwd"
HOME="$SANDBOX/home" GRAPH_HOME="$SANDBOX/graph-home" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$SANDBOX" \
  "$BINARY" daemon --state-dir "$SANDBOX/state" --graph-home "$SANDBOX/graph-home" \
  --port "$PORT" > "$SANDBOX/daemon.log" 2>&1 &
DAEMON_PID=$!

HEALTH=""
for _ in $(seq 1 300); do
  if HEALTH="$(curl -sf "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"; then
    break
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "FAIL: the daemon exited before serving health" >&2
    cat "$SANDBOX/daemon.log" >&2
    exit 1
  fi
  sleep 0.2
done
if [ -z "$HEALTH" ]; then
  echo "FAIL: /api/health never answered" >&2
  cat "$SANDBOX/daemon.log" >&2
  exit 1
fi
echo "ok: /api/health -> $HEALTH"

TOKEN="$(cat "$SANDBOX/state/session-token")"
CATALOG="$(curl -sf -H "Cookie: graph_session=$TOKEN" "http://127.0.0.1:$PORT/api/catalog")"
for id in master coder reviewer tester; do
  if ! printf '%s' "$CATALOG" | python3 -c "import json,sys; ids={d['id'] for d in json.load(sys.stdin)['definitions']}; sys.exit(0 if '$id' in ids else 1)"; then
    echo "FAIL: bootstrap definition $id is missing from the catalog" >&2
    printf '%s\n' "$CATALOG" >&2
    exit 1
  fi
done
echo "ok: catalog carries master, coder, reviewer, tester from the embedded preset pack"

if grep -q 'Bootstrap preset pack not available' "$SANDBOX/daemon.log"; then
  echo "FAIL: the daemon reported a missing preset pack" >&2
  cat "$SANDBOX/daemon.log" >&2
  exit 1
fi
echo "ok: no missing preset pack was reported"

for name in check-resolver.cjs module-worker.mjs extension-worker.mjs; do
  if [ ! -f "$SANDBOX/graph-home/assets/runtime/$name" ]; then
    echo "FAIL: $name was not extracted from the binary" >&2
    find "$SANDBOX/graph-home" -maxdepth 3 >&2
    exit 1
  fi
done
echo "ok: runtime scripts were extracted from the binary itself"

echo "PASS: the packaged binary runs with no external assets"
