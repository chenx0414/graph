package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"
)

type shell struct {
	paths   Paths
	window  *mygo.Window
	pending string
	console string
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
	s.spawnDaemon()
	for attempt := 0; attempt < 160; attempt++ {
		if info, ok := s.paths.ReadConsole(); ok && s.paths.Reachable(info.URL) {
			return info.URL
		}
		time.Sleep(250 * time.Millisecond)
	}
	return ""
}

func (s *shell) spawnDaemon() {
	logPath := filepath.Join(s.paths.StateDir, "daemon-shell.log")
	file, err := os.Create(logPath)
	if err != nil {
		log.Printf("[app] cannot open %s: %v", logPath, err)
		return
	}
	command := exec.Command(s.paths.DaemonBin, s.paths.DaemonArgs()...)
	command.Stdout = file
	command.Stderr = file
	if err := command.Start(); err != nil {
		log.Printf("[app] cannot start %s: %v", s.paths.DaemonBin, err)
		file.Close()
		return
	}
	go func() {
		_ = command.Wait()
		file.Close()
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
	s := &shell{paths: DefaultPaths()}
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
		s.window = mygo.NewWindow(mygo.WindowOptions{
			Title:     "Graph",
			Width:     1200,
			Height:    820,
			MinWidth:  860,
			MinHeight: 600,
			StateKey:  "console",
			URL:       s.console + s.pending,
		})
		s.createTray()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
