package graph

import (
	"fmt"
	"os"
	"sync"
	"time"
)

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
