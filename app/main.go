package main

import (
	_ "embed"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

//go:embed preload.js
var preloadSource string

type shell struct {
	paths      Paths
	window     *mygo.Window
	bridge     *bridge
	daemon     *daemon
	pending    string
	console    string
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

func resourceDirectory(graphHome, kind string) (string, error) {
	switch kind {
	case "skills", "mcp", "pi-extensions", "agent-md":
		return filepath.Join(graphHome, "capabilities", kind), nil
	case "prompts":
		return filepath.Join(graphHome, "prompts"), nil
	}
	return "", errors.New("unknown resource library")
}

func (s *shell) api() *shellAPI {
	return &shellAPI{
		secrets: secretsPath(s.paths.StateDir),
		pick: func() (string, error) {
			chosen, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Title: "选择项目目录", Directory: true, CreateDirectories: true})
			if err != nil || len(chosen) == 0 {
				return "", err
			}
			return chosen[0], nil
		},
		open: func(kind string) (string, error) {
			directory, err := resourceDirectory(s.paths.GraphHome, kind)
			if err != nil {
				return "", err
			}
			if err := os.MkdirAll(directory, 0o755); err != nil {
				return directory, err
			}
			return directory, mygo.Shell.OpenPath(directory)
		},
		relaunch: func() string {
			mygo.App.Relaunch()
			return s.console
		},
		apply: func() (bool, string) {
			return s.daemon.restart()
		},
	}
}

func (s *shell) open(route string) {
	if s.window == nil {
		s.pending = route
		return
	}
	s.window.Page().LoadURL(s.console + route)
	s.window.Show()
	s.window.Focus()
}

func (s *shell) ensureDaemon() string {
	if info, ok := s.paths.ReadConsole(); ok && s.paths.Reachable(info.URL) {
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

func (s *shell) openNativeChat() {
	state := newChatState(s.console, s.paths.SessionToken())
	window := mygo.NewWindow(mygo.WindowOptions{
		Title:     "Graph · 会话（原生预览）",
		Width:     820,
		Height:    720,
		MinWidth:  480,
		MinHeight: 360,
		Content:   ui.View(state.view),
	})
	go func() {
		state.load()
		window.Update(func() {})
	}()
}

func (s *shell) createTray() {
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{ID: "console", Label: "打开控制台", Click: func(*mygo.MenuItem, *mygo.Window) { s.open("") }},
		{ID: "outside", Label: "在浏览器中打开", Click: func(*mygo.MenuItem, *mygo.Window) {
			if s.console != "" {
				_ = mygo.Shell.OpenExternal(s.console)
			}
		}},
		{ID: "native-chat", Label: "打开原生会话（预览）", Click: func(*mygo.MenuItem, *mygo.Window) { s.openNativeChat() }},
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
	mygo.App.OnOpenURL(func(raw string) {
		if route, ok := RouteOf(raw); ok {
			s.open(route)
		}
	})
	mygo.App.WhenReady(func() {
		s.console = s.ensureDaemon()
		if s.console == "" {
			log.Fatal("[app] the daemon did not come up")
		}
		started, err := startBridge(s.api(), newBridgeToken())
		if err != nil {
			log.Printf("[app] bridge: %v", err)
		}
		s.bridge = started
		s.window = mygo.NewWindow(mygo.WindowOptions{
			Title:     "Graph",
			Width:     1200,
			Height:    820,
			MinWidth:  860,
			MinHeight: 600,
			StateKey:  "console",
			URL:       s.console + s.pending,
			Page: mygo.PageOptions{
				PreloadScript:    preloadScript(preloadSource, s.bridge.token, s.bridge.address),
				PreloadAllFrames: true,
			},
		})
		s.createTray()
		go s.watchTasks()
		go s.watchRsi()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
