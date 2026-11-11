package main

import (
	"log"
	"os"
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

func (s *shell) watchBuild(path string) {
	stamp, ok := executableStamp(path)
	if !ok || path == "" {
		return
	}
	for range time.Tick(5 * time.Second) {
		next, ok := executableStamp(path)
		if ok && executableReplaced(stamp, next) {
			log.Printf("[app] %s was replaced by a new build; replacing this process", path)
			if err := syscall.Exec(path, os.Args, os.Environ()); err != nil {
				log.Printf("[app] replacing this process failed: %v", err)
			}
			return
		}
	}
}
