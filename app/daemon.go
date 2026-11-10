package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

type daemon struct {
	mu      sync.Mutex
	paths   Paths
	command *exec.Cmd
	owned   bool
	stopped bool
}

func newDaemon(paths Paths) *daemon { return &daemon{paths: paths} }

func (d *daemon) environment() []string {
	env := os.Environ()
	values := secretValues(secretsPath(d.paths.StateDir))
	names := make([]string, 0, len(values))
	for ref := range values {
		names = append(names, ref)
	}
	for _, ref := range names {
		env = append(env, ref+"="+values[ref])
	}
	return env
}

func (d *daemon) start() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.command != nil {
		return nil
	}
	logPath := filepath.Join(d.paths.StateDir, "daemon-shell.log")
	file, err := os.Create(logPath)
	if err != nil {
		return err
	}
	command := exec.Command(d.paths.DaemonBin, d.paths.DaemonArgs()...)
	command.Stdout = file
	command.Stderr = file
	command.Env = d.environment()
	if err := command.Start(); err != nil {
		file.Close()
		return err
	}
	d.command = command
	d.owned = true
	go func() {
		_ = command.Wait()
		file.Close()
		d.mu.Lock()
		mine := d.command == command
		quit := d.stopped
		if mine {
			d.command = nil
		}
		d.mu.Unlock()
		if mine && !quit {
			notify("Graph 的后台已退出", "打开 Graph 会重新拉起它；会话数据仍在磁盘上。")
		}
	}()
	return nil
}

func (d *daemon) stop() {
	d.mu.Lock()
	command := d.command
	d.command = nil
	d.mu.Unlock()
	if command != nil && command.Process != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
	}
}

func (d *daemon) running() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.command != nil
}

func (d *daemon) restart() (bool, string) {
	if !d.running() {
		return false, "Graph 的后台不是这个窗口拉起的，重启 Graph 后新密钥才会生效"
	}
	d.stop()
	if err := d.start(); err != nil {
		return false, err.Error()
	}
	for attempt := 0; attempt < 160; attempt++ {
		if info, ok := d.paths.ReadConsole(); ok && d.paths.Reachable(info.URL) {
			return true, ""
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false, "后台重启后没有在 40 秒内就绪"
}

func (d *daemon) shutdown() {
	d.mu.Lock()
	d.stopped = true
	d.mu.Unlock()
	d.stop()
}

func notify(title, body string) {
	if !mygo.NotificationsSupported() {
		return
	}
	note := mygo.NewNotification(mygo.NotificationOptions{ID: "graph-shell", Title: title, Body: body})
	_ = note.Show()
}

func secretNames(stateDir string) []string {
	names := []string{}
	for ref := range secretValues(secretsPath(stateDir)) {
		names = append(names, ref)
	}
	return names
}

func envHas(env []string, name, value string) bool {
	for _, entry := range env {
		if strings.HasPrefix(entry, name+"=") {
			return entry == name+"="+value
		}
	}
	return false
}
