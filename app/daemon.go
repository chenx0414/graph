package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

type daemon struct {
	mu         sync.Mutex
	paths      Paths
	command    *exec.Cmd
	adoptedPid int
	owned      bool
	launched   bool
	stopped    bool
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
	if d.command != nil || d.launched {
		return nil
	}
	d.adoptedPid = 0
	d.launched = d.startThroughLaunchAgent() == nil
	if d.launched {
		return nil
	}
	return d.startDirectly()
}

func (d *daemon) startThroughLaunchAgent() error {
	d.stopStaleDaemon()
	if insideAppBundle(d.paths.DaemonBin) {
		d.paths.dropStableDaemon()
		if _, err := installLaunchAgent(d.paths); err != nil {
			return err
		}
		return launchAgentBoot(d.paths)
	}
	if _, err := installStableDaemon(d.paths.DaemonBin, stableDaemonPath(d.paths)); err != nil {
		return err
	}
	if _, err := installLaunchAgent(d.paths); err != nil {
		return err
	}
	return launchAgentBoot(d.paths)
}

type daemonRefresh struct {
	restart bool
	reload  bool
}

func (d *daemon) refresh() daemonRefresh {
	definitionChanged := false
	if insideAppBundle(d.paths.DaemonBin) {
		d.paths.dropStableDaemon()
	} else {
		changed, err := installStableDaemon(d.paths.DaemonBin, stableDaemonPath(d.paths))
		if err != nil {
			return daemonRefresh{}
		}
		definitionChanged = changed
	}
	agentChanged, err := installLaunchAgent(d.paths)
	if err != nil {
		return daemonRefresh{}
	}
	definitionChanged = definitionChanged || agentChanged
	info, ok := d.paths.ReadConsole()
	if !ok {
		return daemonRefresh{}
	}
	if !daemonSupervised(info.PID) {
		return daemonRefresh{restart: true, reload: true}
	}
	return daemonRefresh{restart: definitionChanged || d.paths.daemonStale(info), reload: definitionChanged}
}

func (d *daemon) stopStaleDaemon() {
	info, ok := d.paths.ReadConsole()
	if !ok || info.PID <= 0 || info.PID == os.Getpid() {
		return
	}
	if processAlive(info.PID) {
		stopAdoptedProcess(info.PID)
	}
}

func (d *daemon) startDirectly() error {
	logPath := filepath.Join(d.paths.StateDir, "daemon-shell.log")
	file, err := os.Create(logPath)
	if err != nil {
		return err
	}
	command := exec.Command(d.paths.DaemonBin, d.paths.DaemonCommand()...)
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

func (d *daemon) adopt(pid int) {
	if pid <= 0 {
		return
	}
	d.mu.Lock()
	if d.command == nil {
		d.adoptedPid = pid
	}
	d.mu.Unlock()
}

func (d *daemon) stop() {
	d.mu.Lock()
	command := d.command
	d.command = nil
	launched := d.launched
	d.launched = false
	adopted := d.adoptedPid
	d.adoptedPid = 0
	d.mu.Unlock()
	if launched {
		return
	}
	if command != nil && command.Process != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return
	}
	if adopted != 0 {
		stopAdoptedProcess(adopted)
	}
}

func (d *daemon) running() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.command != nil {
		return true
	}
	return d.adoptedPid != 0 && processAlive(d.adoptedPid)
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func stopAdoptedProcess(pid int) {
	_ = syscall.Kill(pid, syscall.SIGTERM)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

func (d *daemon) supervised() bool {
	info, ok := d.paths.ReadConsole()
	if !ok {
		return false
	}
	return daemonSupervised(info.PID)
}

func (d *daemon) restart(reload bool) (bool, string) {
	d.mu.Lock()
	launched := d.launched
	d.mu.Unlock()
	if launched || d.supervised() {
		d.stopStaleDaemon()
		if err := runLaunchAgentPlan(launchAgentPlan(d.paths, reload)); err != nil {
			return false, err.Error()
		}
	} else {
		if !d.running() {
			return false, "Graph 的后台不是这个窗口拉起的，重启 Graph 后新密钥才会生效"
		}
		d.stop()
		if err := d.start(); err != nil {
			return false, err.Error()
		}
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
