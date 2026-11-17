package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

func tailFile(path string, lines int) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n")
}

func contextWithTimeout(seconds int) (context.Context, context.CancelFunc) {
	if seconds <= 0 {
		seconds = 120
	}
	return context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
}

// keeperSource runs the daemon as its own child and waits for it. The daemon's
// parent staying alive is deliberate: app/launchd.go treats ppid==1 as a
// launchd-supervised daemon, and its refresh path would stop it on window open.
const keeperSource = `#!/bin/sh
# verify-graph daemon keeper: keep the daemon a child so it does not look
# launchd-supervised to the app. Exit when the daemon exits; kill it on TERM.
"$@" &
child=$!
printf '%s\n' "$child" > "$VG_DAEMON_PIDFILE"
trap 'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null' TERM INT
wait "$child"
status=$?
kill "$child" 2>/dev/null
rm -f "$VG_DAEMON_PIDFILE"
exit $status
`

// waitForDaemonPID reads the pid the keeper writes for its child, falling back
// to the keeper pid if the file never appears (the readiness loop then reports
// the real failure instead of hanging).
func waitForDaemonPID(pidPath string, fallback int, timeout time.Duration) int {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(pidPath); err == nil {
			pid := 0
			if _, scanErr := fmt.Sscanf(strings.TrimSpace(string(raw)), "%d", &pid); scanErr == nil && pid > 0 && alive(pid) {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fallback
}
