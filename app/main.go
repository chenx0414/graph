package main

import (
	_ "embed"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	graphdaemon "github.com/chenx0414/graph/backend/daemon"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type daemonController interface {
	start() error
	adopt(pid int)
	refresh() daemonRefresh
	restart(reload bool) (bool, string)
	status() daemonStatus
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
		tasks, err := fetchTasks(newAPIClient(s.console, s.paths.SessionToken()))
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
		if result := s.daemon.refresh(); result.restart {
			if restarted, _ := s.daemon.restart(result.reload); restarted {
				if fresh, ok := s.paths.ReadConsole(); ok {
					return fresh.URL
				}
			}
		}
		s.daemon.adopt(info.PID)
		return info.URL
	}
	if err := s.daemon.start(); err != nil {
		log.Printf("[app] cannot start %s: %v", stableDaemonPath(s.paths), err)
	}
	for attempt := 0; attempt < 160; attempt++ {
		if info, ok := s.paths.ReadConsole(); ok && s.paths.Reachable(info.URL) {
			return info.URL
		}
		time.Sleep(250 * time.Millisecond)
	}
	return ""
}

func (s *shell) watchConversation() {
	for range time.Tick(3 * time.Second) {
		var state *shellState
		mygo.RunOnMain(func() {
			state = s.chat
			if state != nil {
				state.adoptConsole(s.paths)
			}
		})
		if state == nil {
			continue
		}
		if state.refresh() {
			state.frame()
		}
	}
}

func (s *shell) openNative() {
	if s.native != nil {
		s.native.Show()
		s.native.Focus()
		return
	}
	state := newShellState(s.console, s.paths.SessionToken())
	state.stateDir = s.paths.StateDir
	state.loadBoard(s.paths.StateDir)
	state.blockBoardDataUntilConversation()
	window := mygo.NewWindow(mygo.WindowOptions{
		Title:                "Graph",
		Width:                1440,
		Height:               900,
		MinWidth:             windowFloorWidth(),
		MinHeight:            windowFloorHeight(),
		StateKey:             "native",
		TitleBarStyle:        mygo.TitleBarHidden,
		TrafficLightPosition: trafficLightPoint(),
		Content:              ui.View(state.view),
	})
	state.window = window
	s.native = window
	s.chat = state
	go func() {
		state.load()
		state.markConversationReady()
		state.ensureUsage()
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
		ToolTip:        "Graph · 后台：" + s.daemon.status().Phase.Label(),
		Menu:           menu,
	}); err != nil {
		log.Printf("[app] tray: %v", err)
	}
}

func trafficLightPoint() *mygo.Point {
	position := trafficLightPosition()
	return &position
}

func trafficLightPosition() mygo.Point {
	return mygo.Point{X: 16, Y: 15}
}

func main() {
	if inDaemonMode(os.Args[1:]) {
		graphdaemon.Run(os.Args[2:])
		return
	}
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
		go s.watchConversation()
		if executable, err := os.Executable(); err == nil {
			go s.watchBuild(executable)
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
