package main

import (
	_ "embed"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type daemonController interface {
	start() error
	adopt(pid int)
	restart() (bool, string)
}

type shell struct {
	chat       *shellState
	native     *mygo.Window
	paths      Paths
	daemon     daemonController
	console    string
	rsiTried   string
	restarting atomic.Bool
}

func (s *shell) watchTasks() {
	state := newNotificationState()
	for range time.Tick(15 * time.Second) {
		if s.console == "" {
			continue
		}
		tasks, err := fetchTasks(s.console, s.paths.SessionToken())
		if err != nil {
			continue
		}
		decisions, _ := taskDecisions(state, tasks)
		for _, decided := range decisions {
			notify(decided.Title, decided.Body)
		}
	}
}

func (s *shell) ensureDaemon() string {
	if info, ok := s.paths.ReadConsole(); ok && s.paths.Reachable(info.URL) {
		s.daemon.adopt(info.PID)
		return info.URL
	}
	if err := s.daemon.start(); err != nil {
		log.Printf("[app] cannot start %s: %v", s.paths.DaemonBin, err)
	}
	for attempt := 0; attempt < 160; attempt++ {
		if info, ok := s.paths.ReadConsole(); ok && s.paths.Reachable(info.URL) {
			return info.URL
		}
		time.Sleep(250 * time.Millisecond)
	}
	return ""
}

func (s *shell) openNative() {
	if s.native != nil {
		s.native.Show()
		s.native.Focus()
		return
	}
	state := newShellState(s.console, s.paths.SessionToken())
	window := mygo.NewWindow(mygo.WindowOptions{
		Title:     "Graph",
		Width:     1080,
		Height:    760,
		MinWidth:  720,
		MinHeight: 480,
		StateKey:  "native",
		Content:   ui.View(state.view),
	})
	state.window = window
	s.native = window
	s.chat = state
	go func() {
		state.load()
		state.frame()
	}()
}

func (s *shell) createTray() {
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{ID: "native", Label: "打开 Graph", Click: func(*mygo.MenuItem, *mygo.Window) { s.openNative() }},
		mygo.Separator(),
		{ID: "quit", Label: "退出 Graph", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	})
	icon, _ := os.ReadFile(filepath.Join(s.paths.SourceRoot, "build", "trayTemplate.png"))
	if _, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "graph",
		Icon:           icon,
		IconIsTemplate: true,
		ToolTip:        "Graph",
		Menu:           menu,
	}); err != nil {
		log.Printf("[app] tray: %v", err)
	}
}

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		mygo.App.Quit()
		return
	}
	paths := DefaultPaths()
	s := &shell{paths: paths, daemon: newDaemon(paths)}
	mygo.App.WhenReady(func() {
		s.console = s.ensureDaemon()
		if s.console == "" {
			log.Fatal("[app] the daemon did not come up")
		}
		s.openNative()
		s.createTray()
		go s.watchTasks()
		go s.watchRsi()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
