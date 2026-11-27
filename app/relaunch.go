package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type fileStamp struct {
	Size  int64
	Mod   time.Time
	Inode uint64
}

func executableStamp(path string) (fileStamp, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}, false
	}
	stamp := fileStamp{Size: info.Size(), Mod: info.ModTime()}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		stamp.Inode = uint64(stat.Ino)
	}
	return stamp, true
}

func executableReplaced(before, after fileStamp) bool {
	return before.Size != after.Size || !before.Mod.Equal(after.Mod) || before.Inode != after.Inode
}

func stampLabel(stamp fileStamp) string {
	return fmt.Sprintf("size=%d inode=%d modified=%s", stamp.Size, stamp.Inode, stamp.Mod.UTC().Format(time.RFC3339))
}

func (s *shell) recordRelaunch(path string, before, after fileStamp) {
	line := fmt.Sprintf("%s %s %s -> %s\n", time.Now().UTC().Format(time.RFC3339), path, stampLabel(before), stampLabel(after))
	file, err := os.OpenFile(filepath.Join(s.paths.StateDir, "app-relaunch.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = file.WriteString(line)
	_ = file.Close()
}

// execSelf replaces this process with the binary at path.
func execSelf(path string) error {
	return syscall.Exec(path, os.Args, os.Environ())
}

func (s *shell) watchBuild(path string) {
	stamp, ok := executableStamp(path)
	if !ok || path == "" {
		return
	}
	gate := s.reloadGate()
	for range time.Tick(reloadPollInterval) {
		next, ok := executableStamp(path)
		if !ok {
			continue
		}
		if gate.consider(path, stamp, next) {
			log.Printf("[app] %s was replaced by a new build; this process took it", path)
			s.recordRelaunch(path, stamp, next)
			return
		}
		if gate.pending() {
			// The stamp is deliberately not advanced: the gate has to keep seeing
			// the build it is holding back, or it would conclude nothing changed and
			// the new binary would never run.
			log.Printf("[app] %s changed but work is in flight; reload is deferred", path)
		}
	}
}
