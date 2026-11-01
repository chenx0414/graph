package graph

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// execDebugTimeline appends one line to the timeline named by GRAPH_EXEC_DEBUG.
//
// It exists because a command that never returns can only be diagnosed from the
// inside: the caller never comes back, so the executor has to say when it
// launched, when its timer fired, what the kill returned and whether the pipes
// ever drained. Off unless the variable names a file.
var execDebugMutex sync.Mutex

func execDebugTimeline(format string, values ...any) {
	path := os.Getenv("GRAPH_EXEC_DEBUG")
	if path == "" {
		return
	}
	execDebugMutex.Lock()
	defer execDebugMutex.Unlock()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintf(file, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, values...))
}
