package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type boardPanel struct {
	ID       string  `json:"id"`
	Kind     string  `json:"kind"`
	X        float32 `json:"x"`
	Y        float32 `json:"y"`
	W        float32 `json:"w"`
	H        float32 `json:"h"`
	Expanded bool    `json:"expanded"`
}

type boardFile struct {
	Version int          `json:"version"`
	Panels  []boardPanel `json:"panels"`
}

const boardLayoutVersion = 1

func defaultBoardPanels() []boardPanel {
	return []boardPanel{
		{ID: "overview", Kind: "overview", X: 16, Y: 56, W: 276, H: 260},
		{ID: "tasks", Kind: "tasks", X: 16, Y: 328, W: 276, H: 260},
		{ID: "history", Kind: "history", X: 16, Y: 600, W: 276, H: 220},
		{ID: "artifacts", Kind: "artifacts", X: 304, Y: 56, W: 276, H: 300},
	}
}

func boardPanelTitle(kind string) string {
	switch kind {
	case "overview":
		return "项目概览"
	case "conversation":
		return "对话信息"
	case "history":
		return "历史记录"
	case "tasks":
		return "任务清单"
	case "graph":
		return "图谱画布"
	case "capabilities":
		return "能力库"
	case "settings":
		return "运行设置"
	case "artifacts":
		return "共享产物"
	case "models":
		return "模型配置"
	case "questions":
		return "待答问题"
	}
	return kind
}

func boardPanelSize(kind string) (float32, float32) {
	switch kind {
	case "graph":
		return 440, 340
	case "artifacts":
		return 440, 300
	case "capabilities", "settings":
		return 460, 420
	}
	return 320, 250
}

func (s *shellState) loadBoard(stateDir string) {
	s.board.path = filepath.Join(stateDir, "whiteboard.json")
	s.board.panels = defaultBoardPanels()
	payload, err := os.ReadFile(s.board.path)
	if err != nil {
		return
	}
	var file boardFile
	if json.Unmarshal(payload, &file) != nil || len(file.Panels) == 0 {
		return
	}
	s.board.panels = file.Panels
}

func (s *shellState) saveBoard() {
	if s.board.path == "" {
		return
	}
	payload, err := json.MarshalIndent(boardFile{Version: boardLayoutVersion, Panels: s.board.panels}, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.board.path), 0o755); err != nil {
		return
	}
	temp := s.board.path + ".new"
	if os.WriteFile(temp, append(payload, '\n'), 0o600) == nil {
		_ = os.Rename(temp, s.board.path)
	}
}

func (s *shellState) panelOf(kind string) *boardPanel {
	for index := range s.board.panels {
		if s.board.panels[index].Kind == kind {
			return &s.board.panels[index]
		}
	}
	return nil
}

func (s *shellState) expandedPanel() *boardPanel {
	for index := range s.board.panels {
		if s.board.panels[index].Expanded {
			return &s.board.panels[index]
		}
	}
	return nil
}

func (s *shellState) openModule(kind string) {
	s.board.lastKind = kind
	s.board.adding = false
	panel := s.panelOf(kind)
	if panel == nil {
		width, height := boardPanelSize(kind)
		count := len(s.board.panels)
		s.board.panels = append(s.board.panels, boardPanel{
			ID:   kind,
			Kind: kind,
			X:    16 + float32(count%2)*36,
			Y:    56 + float32(count%4)*36,
			W:    width,
			H:    height,
		})
	}
	for index := range s.board.panels {
		s.board.panels[index].Expanded = s.board.panels[index].Kind == kind
	}
	switch kind {
	case "overview":
		s.ensureUsage()
	case "capabilities":
		s.ensureResources()
	case "settings":
		s.ensureSettings()
	case "models":
		if active := s.active(); active != nil {
			go active.loadModels()
		}
	case "graph":
		s.ensureGraph()
	}
	s.saveBoard()
	s.frame()
}

func (s *shellState) closeModule(id string) {
	kept := make([]boardPanel, 0, len(s.board.panels))
	for _, panel := range s.board.panels {
		if panel.ID != id {
			kept = append(kept, panel)
		}
	}
	s.board.panels = kept
	s.saveBoard()
	s.frame()
}

func (s *shellState) resetBoard() {
	s.board.panels = defaultBoardPanels()
	s.board.lastKind = ""
	s.saveBoard()
	s.frame()
}

func (s *shellState) canvasSize() (float32, float32) {
	width, height := float32(960), float32(900)
	for _, panel := range s.board.panels {
		width = max(width, panel.X+panel.W+48)
		height = max(height, panel.Y+panel.H+48)
	}
	return width, height
}
