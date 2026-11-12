package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"time"
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

type boardPage struct {
	ID     string       `json:"id"`
	Title  string       `json:"title"`
	Kind   string       `json:"kind,omitempty"`
	Panels []boardPanel `json:"panels"`
}

type boardFile struct {
	Version int          `json:"version"`
	Panels  []boardPanel `json:"panels,omitempty"`
	Pages   []boardPage  `json:"pages,omitempty"`
	Active  int          `json:"active"`
}

const boardLayoutVersion = 2

const boardDefaultTitle = "白板"

func defaultBoardPanels() []boardPanel {
	return []boardPanel{
		{ID: "overview", Kind: "overview", X: 16, Y: 56, W: 276, H: 260},
		{ID: "tasks", Kind: "tasks", X: 16, Y: 328, W: 276, H: 260},
		{ID: "history", Kind: "history", X: 16, Y: 600, W: 276, H: 220},
		{ID: "artifacts", Kind: "artifacts", X: 304, Y: 56, W: 276, H: 300},
	}
}

func defaultBoardPages() []boardPage {
	return []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: defaultBoardPanels()}}
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

func (s *shellState) loadBoard(stateDir string) {
	s.board.path = filepath.Join(stateDir, "whiteboard.json")
	s.board.pages = defaultBoardPages()
	s.board.active = 0
	payload, err := os.ReadFile(s.board.path)
	if err != nil {
		return
	}
	var file boardFile
	if json.Unmarshal(payload, &file) != nil {
		return
	}
	switch {
	case len(file.Pages) > 0:
		s.board.pages = file.Pages
	case len(file.Panels) > 0:
		s.board.pages = []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: file.Panels}}
	}
	s.board.active = clampIndex(file.Active, len(s.board.pages))
}

func (s *shellState) saveBoard() {
	if s.board.path == "" {
		return
	}
	payload, err := json.MarshalIndent(boardFile{Version: boardLayoutVersion, Pages: s.board.pages, Active: s.board.active}, "", "  ")
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

func clampIndex(index, length int) int {
	if length <= 0 {
		return 0
	}
	return min(max(index, 0), length-1)
}

func (s *shellState) boardPage() *boardPage {
	if len(s.board.pages) == 0 {
		s.board.pages = defaultBoardPages()
		s.board.active = 0
	}
	s.board.active = clampIndex(s.board.active, len(s.board.pages))
	return &s.board.pages[s.board.active]
}

func (s *shellState) activeBoardKind() string {
	return s.boardPage().Kind
}

func (s *shellState) panelOf(kind string) *boardPanel {
	page := s.boardPage()
	for index := range page.Panels {
		if page.Panels[index].Kind == kind {
			return &page.Panels[index]
		}
	}
	return nil
}

func (s *shellState) openModule(kind string) {
	for index := range s.board.pages {
		if s.board.pages[index].Kind == kind {
			s.selectBoardPage(index)
			return
		}
	}
	title := boardPanelTitle(kind)
	s.board.pages = append(s.board.pages, boardPage{
		ID:    "tab-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Title: title,
		Kind:  kind,
		Panels: []boardPanel{
			{ID: kind, Kind: kind, Expanded: true},
		},
	})
	s.board.active = len(s.board.pages) - 1
	s.ensureBoardPageData()
	s.saveBoard()
	s.frame()
}

func (s *shellState) selectBoardPage(index int) {
	index = clampIndex(index, len(s.board.pages))
	if index == s.board.active {
		return
	}
	s.board.active = index
	s.ensureBoardPageData()
	s.saveBoard()
	s.frame()
}

func (s *shellState) addBoardPage() {
	count := 1
	for _, page := range s.board.pages {
		if page.Kind == "" {
			count++
		}
	}
	s.board.pages = append(s.board.pages, boardPage{
		ID:     "tab-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Title:  boardDefaultTitle + " " + strconv.Itoa(count),
		Panels: defaultBoardPanels(),
	})
	s.board.active = len(s.board.pages) - 1
	s.saveBoard()
	s.frame()
}

func (s *shellState) closeBoardPage(index int) {
	if len(s.board.pages) <= 1 {
		return
	}
	index = clampIndex(index, len(s.board.pages))
	s.board.pages = append(s.board.pages[:index], s.board.pages[index+1:]...)
	if s.board.active > index {
		s.board.active--
	}
	s.board.active = clampIndex(s.board.active, len(s.board.pages))
	s.saveBoard()
	s.frame()
}

func (s *shellState) closeModule(id string) {
	page := s.boardPage()
	kept := make([]boardPanel, 0, len(page.Panels))
	for _, panel := range page.Panels {
		if panel.ID != id {
			kept = append(kept, panel)
		}
	}
	page.Panels = kept
	s.saveBoard()
	s.frame()
}

func (s *shellState) ensureBoardPageData() {
	switch s.activeBoardKind() {
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
}

func (s *shellState) canvasSize() (float32, float32) {
	width, height := float32(960), float32(900)
	for _, panel := range s.boardPage().Panels {
		width = max(width, panel.X+panel.W+48)
		height = max(height, panel.Y+panel.H+48)
	}
	return width, height
}
