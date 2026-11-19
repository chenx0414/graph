package main

import (
	"strconv"
	"time"
)

type boardPanel struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Scope string `json:"scope,omitempty"`
	Slot  int    `json:"slot,omitempty"`
}

type boardSlot struct {
	Weight float32   `json:"weight"`
	Node   boardNode `json:"node"`
}

type boardNode struct {
	Kind     string      `json:"kind"`
	Axis     string      `json:"axis,omitempty"`
	Children []boardSlot `json:"children,omitempty"`
	PanelID  string      `json:"panelId,omitempty"`
}

type boardPage struct {
	ID     string       `json:"id"`
	Title  string       `json:"title"`
	Kind   string       `json:"kind,omitempty"`
	Scope  string       `json:"scope,omitempty"`
	Panels []boardPanel `json:"panels"`
	Layout boardNode    `json:"layout"`
}

type boardFile struct {
	Version int          `json:"version"`
	Panels  []boardPanel `json:"panels,omitempty"`
	Pages   []boardPage  `json:"pages,omitempty"`
	Active  int          `json:"active"`
}

const boardLayoutVersion = 17

const boardDefaultTitle = "白板"

const (
	boardContextRowWeight       = 1.0
	boardNetworkRowWeight       = 4.67
	boardCollaborationRowWeight = 2.61
)

const boardMinPaneWidth = 140

const boardMinPaneHeight = 90

func defaultBoardPanels() []boardPanel {
	return []boardPanel{
		{ID: "context-overview", Kind: "context-overview"},
		{ID: "agent-network", Kind: "agent-network"},
		{ID: "fleet-collaboration", Kind: "fleet-collaboration"},
	}
}

func defaultBoardLayout() boardNode {
	return boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
		{Weight: boardContextRowWeight, Node: boardNode{Kind: "panel", PanelID: "context-overview"}},
		{Weight: boardNetworkRowWeight, Node: boardNode{Kind: "panel", PanelID: "agent-network"}},
		{Weight: boardCollaborationRowWeight, Node: boardNode{Kind: "panel", PanelID: "fleet-collaboration"}},
	}}
}

func layoutFromPanels(panels []boardPanel) boardNode {
	ordered := append([]boardPanel(nil), panels...)
	for index := range ordered {
		if ordered[index].Slot != index {
			for swap := index + 1; swap < len(ordered); swap++ {
				if ordered[swap].Slot == index {
					ordered[index], ordered[swap] = ordered[swap], ordered[index]
					break
				}
			}
		}
	}
	layout := boardNode{Kind: "split", Axis: "column"}
	for row := 0; row*2 < len(ordered); row++ {
		line := boardNode{Kind: "split", Axis: "row"}
		for column := 0; column < 2; column++ {
			index := row*2 + column
			if index >= len(ordered) {
				break
			}
			line.Children = append(line.Children, boardSlot{Weight: 1, Node: boardNode{Kind: "panel", PanelID: ordered[index].ID}})
		}
		layout.Children = append(layout.Children, boardSlot{Weight: 1, Node: line})
	}
	return layout
}

func defaultBoardPages() []boardPage {
	return []boardPage{defaultBoardPage()}
}

func boardPanelTitle(kind string) string {
	switch kind {
	case "overview":
		return "项目概览"
	case "conversation":
		return "对话信息"
	case "history":
		return "历史记录"
	case "trajectory":
		return "轨迹量化"
	case "trajectory-summary":
		return "上下文统计"
	case "trajectory-tokens":
		return "Token 统计"
	case "trajectory-timing":
		return "耗时统计"
	case "context-overview":
		return "当前上下文"
	case "trajectory-trend":
		return "上下文趋势"
	case "trajectory-events":
		return "上下文事件"
	case "trajectory-commands":
		return "命令执行"
	case "trajectory-files":
		return "文件活动"
	case "trajectory-composition":
		return "Token 组成"
	case "trajectory-requests":
		return "请求浏览"
	case "trajectory-agents":
		return "Agent 网络"
	case "trajectory-request-detail":
		return "请求详情"
	case "tasks":
		return "任务清单"
	case "agent":
		return "Agent 面板"

	case "providers":
		return "供应商"
	case "capabilities":
		return "资源库"
	case "assemblies":
		return "能力装配"
	case "settings":
		return "运行设置"
	case "artifacts":
		return "共享产物"
	case "models":
		return "模型配置"
	case "questions":
		return "待答问题"
	case "fleet-kpi":
		return "编队总览"
	case "fleet-network", "agent-network":
		return "Agent 网络"
	case "fleet-collaboration":
		return "跨 Agent 协作"
	case "fleet-events":
		return "事件检查"
	case "fleet-artifacts":
		return "共享产物"
	case "fleet-history-list":
		return "历史图"
	case "agent-detail":
		return "Agent 详情"
	case "graph-dag":
		return "Graph 编队"
	}
	return kind
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

func (s *shellState) panelByID(id string) *boardPanel {
	page := s.boardPage()
	for index := range page.Panels {
		if page.Panels[index].ID == id {
			return &page.Panels[index]
		}
	}
	return nil
}

func (s *shellState) openModule(kind string) {
	s.openModuleWithScope(kind, "")
}

func (s *shellState) openModuleWithScope(kind, scope string) {
	for index := range s.board.pages {
		if s.board.pages[index].Kind != kind {
			continue
		}
		if kind == fleetPageID {
			s.selectBoardPage(index)
			return
		}
		s.board.pages[index].Scope = scope
		for panel := range s.board.pages[index].Panels {
			if s.board.pages[index].Panels[panel].Kind == kind {
				s.board.pages[index].Panels[panel].Scope = scope
			}
		}
		s.selectBoardPage(index)
		return
	}
	if kind == fleetPageID {
		s.board.pages = append(s.board.pages, defaultFleetPage())
		s.board.active = len(s.board.pages) - 1
		s.ensureBoardPageData()
		s.saveBoard()
		s.frame()
		return
	}
	title := boardPanelTitle(kind)
	page := boardPage{
		ID:    "tab-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Title: title,
		Kind:  kind,
		Scope: scope,
		Panels: []boardPanel{
			{ID: kind, Kind: kind, Scope: scope},
		},
		Layout: boardNode{Kind: "panel", PanelID: kind},
	}
	if kind == "trajectory" {
		s.boardScrollTop = true
		kinds := trajectoryPageKinds()
		panels := make([]boardPanel, 0, len(kinds))
		for _, panelKind := range kinds {
			panels = append(panels, boardPanel{ID: panelKind, Kind: panelKind})
		}
		page.Panels = panels
		page.Layout = trajectoryPageLayout(kinds)
	}
	s.board.pages = append(s.board.pages, page)
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

func (s *shellState) closeModule(id string) {
	page := s.boardPage()
	removeBoardPanelFromLayout(&page.Layout, id)
	normalizeBoardLayout(&page.Layout)
	pruneBoardPanels(page)
	s.saveBoard()
	s.frame()
}

func trajectoryPageKinds() []string {
	return []string{"trajectory-summary", "trajectory-tokens", "context-overview", "trajectory-timing",
		"trajectory-trend", "trajectory-events", "trajectory-commands", "trajectory-files",
		"trajectory-composition", "trajectory-requests", "trajectory-agents", "trajectory-request-detail"}
}

func trajectoryPageLayout(kinds []string) boardNode {
	rows := []boardSlot{}
	pending := []boardSlot{}
	flush := func() {
		if len(pending) == 0 {
			return
		}
		cells := pending
		pending = nil
		rows = append(rows, boardSlot{Weight: 1, Node: boardNode{Kind: "split", Axis: "row", Children: cells}})
	}
	for _, kind := range kinds {
		cell := boardSlot{Weight: 1, Node: boardNode{Kind: "panel", PanelID: kind}}
		if kind == "context-overview" {
			flush()
			rows = append(rows, boardSlot{Weight: 1, Node: cell.Node})
			continue
		}
		pending = append(pending, cell)
		if len(pending) == 2 {
			flush()
		}
	}
	flush()
	return boardNode{Kind: "split", Axis: "column", Children: rows}
}

func replaceBoardPanelInLayout(node *boardNode, from, to string) {
	if node.Kind == "panel" && node.PanelID == from {
		node.PanelID = to
	}
	for index := range node.Children {
		replaceBoardPanelInLayout(&node.Children[index].Node, from, to)
	}
}

func (s *shellState) ensureBoardPageData() {
	if s.conversationDataBlocked() {
		return
	}
	switch s.activeBoardKind() {
	case "overview":
		s.ensureUsage()
	case "capabilities":
		s.ensureResources()
	case "assemblies":
		s.ensureAssemblies()
	case "settings":
		s.ensureSettings()
	case "models":
		if active := s.active(); active != nil {
			go active.loadModels()
		}
	case "trajectory":
		s.ensureTrajectory()
	case "fleet", "agent":
		s.ensureFleet()
	case "fleet-history":
		s.ensureFleetHistory()
	case "fleet-graph":
		s.ensureFleetGraph()
	}
	if s.trajectoryVisible() {
		s.refreshTrajectory()
	}
}

func (s *shellState) deferBoardDrop(drop func()) {
	s.board.pendingDrop = drop
	s.frame()
}
