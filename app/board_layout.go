package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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

const boardLayoutVersion = 16

const boardDefaultTitle = "白板"

const (
	boardContextRowWeight = 1.75
	boardNetworkRowWeight = 3.25
)

const boardMinPaneWidth = 140

const boardMinPaneHeight = 90

func defaultBoardPanels() []boardPanel {
	return []boardPanel{
		{ID: "agent", Kind: "agent"},
		{ID: "trajectory", Kind: "trajectory"},
		{ID: "context-overview", Kind: "context-overview"},
		{ID: "agent-network", Kind: "agent-network"},
	}
}

func defaultBoardLayout() boardNode {
	return boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
		{Weight: boardContextRowWeight, Node: boardNode{Kind: "panel", PanelID: "context-overview"}},
		{Weight: boardNetworkRowWeight, Node: boardNode{Kind: "panel", PanelID: "agent-network"}},
		{Weight: 3.0, Node: boardNode{Kind: "split", Axis: "row", Children: []boardSlot{
			{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "agent"}},
			{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "trajectory"}},
		}}},
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
	case "insights":
		return "洞察概览"
	case "insights-kpi":
		return "洞察概览"
	case "insights-days":
		return "用量趋势"
	case "insights-sessions":
		return "会话排行"
	case "tasks":
		return "任务清单"
	case "agent":
		return "Agent 面板"

	case "providers":
		return "供应商"
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
	case "fleet-kpi":
		return "编队总览"
	case "fleet-network", "agent-network":
		return "Agent 网络"
	case "fleet-collaboration":
		return "跨 Agent 协作"
	case "fleet-tasks":
		return "协作任务"
	case "fleet-events":
		return "事件检查"
	case "fleet-artifacts":
		return "共享产物"
	case "agent-detail":
		return "Agent 详情"
	case "graph-dag":
		return "Graph 编队"
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
	kept := make([]boardPage, 0, len(file.Pages))
	for _, page := range file.Pages {
		if page.Kind == "history" || page.Kind == "conversation" || page.Kind == "overview" || page.Kind == "graph" {
			continue
		}
		kept = append(kept, page)
	}
	switch {
	case len(kept) > 0:
		s.board.pages = kept
	case len(file.Pages) > 0:
		s.board.pages = defaultBoardPages()
	case len(file.Panels) > 0:
		s.board.pages = []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: file.Panels}}
	}
	for index := range s.board.pages {
		for panel := range s.board.pages[index].Panels {
			if s.board.pages[index].Panels[panel].Kind == "trajectory-context" {
				s.board.pages[index].Panels[panel].Kind = "context-overview"
				s.board.pages[index].Panels[panel].ID = "context-overview"
			}
		}
		replaceBoardPanelInLayout(&s.board.pages[index].Layout, "trajectory-context", "context-overview")
		if s.board.pages[index].Kind == "fleet-network" {
			s.board.pages[index].Kind = "agent-network"
			s.board.pages[index].Scope = "fleet"
		}
	}
	if file.Version < 16 {
		for index := range s.board.pages {
			page := &s.board.pages[index]
			if page.Kind == "" {
				page.Panels = defaultBoardPanels()
				page.Layout = defaultBoardLayout()
			}
		}
	}
	if file.Version < boardLayoutVersion {
		for index := range s.board.pages {
			page := &s.board.pages[index]
			if page.Kind != "trajectory" {
				continue
			}
			kinds := trajectoryPageKinds()
			ordered := make([]boardPanel, 0, len(page.Panels))
			known := map[string]bool{}
			for _, kind := range kinds {
				for _, panel := range page.Panels {
					if panel.Kind == kind {
						ordered = append(ordered, panel)
						known[kind] = true
						break
					}
				}
			}
			for _, panel := range page.Panels {
				if !known[panel.Kind] {
					ordered = append(ordered, panel)
				}
			}
			page.Panels = ordered
			page.Layout = trajectoryPageLayout(kinds)
		}
	}
	if file.Version < 11 {
		kept := make([]boardPage, 0, len(s.board.pages))
		for _, page := range s.board.pages {
			if page.ID == fleetPageID || page.Kind == fleetPageID {
				continue
			}
			kept = append(kept, page)
		}
		s.board.pages = kept
	}
	s.board.pages = dedupeBoardModulePages(s.board.pages)
	for index := range s.board.pages {
		rebalanceBoardDashboardRows(&s.board.pages[index])
	}
	for index := range s.board.pages {
		page := &s.board.pages[index]
		for panel := range page.Panels {
			if page.Panels[panel].Kind == "fleet-network" {
				page.Panels[panel].Kind = "agent-network"
				page.Panels[panel].Scope = "fleet"
			}
		}
		removedPanels := false
		if page.Kind == "" {
			kept := make([]boardPanel, 0, len(page.Panels))
			for _, panel := range page.Panels {
				if panel.Kind == "history" || panel.Kind == "conversation" || panel.Kind == "overview" || panel.Kind == "graph" {
					removeBoardPanelFromLayout(&page.Layout, panel.ID)
					removedPanels = true
					continue
				}
				if panel.Kind == "tasks" && file.Version < boardLayoutVersion {
					panel.Kind = "agent"
				}
				if panel.Kind == "artifacts" && file.Version < boardLayoutVersion {
					panel.Kind = "agent-network"
				}

				kept = append(kept, panel)
			}
			page.Panels = kept
		}
		if page.Kind == "" && len(page.Layout.Children) == 0 && page.Layout.Kind == "" {
			page.Layout = layoutFromPanels(page.Panels)
		}
		if page.Kind != "" && page.Layout.Kind == "" && len(page.Panels) > 0 {
			page.Layout = boardNode{Kind: "panel", PanelID: page.Panels[0].ID}
		}
		normalizeBoardLayout(&page.Layout)
		pruneBoardPanels(page)
		ensureBoardDashboardPanels(page)
		if page.Kind == fleetPageID {
			if file.Version < boardLayoutVersion {
				page.Layout = defaultFleetLayout()
			}
			normalizeBoardLayout(&page.Layout)
			continue
		}
		if removedPanels {
			page.Layout = layoutFromPanels(page.Panels)
			normalizeBoardLayout(&page.Layout)
		}
	}
	s.board.active = clampIndex(file.Active, len(s.board.pages))
	s.pinBoardPages()
	s.saveBoard()
}

func rebalanceBoardDashboardRows(page *boardPage) {
	if page.Kind != "" {
		return
	}
	layout := &page.Layout
	if layout.Kind != "split" || layout.Axis != "column" || len(layout.Children) < 2 {
		return
	}
	first, second := layout.Children[0].Node, layout.Children[1].Node
	if first.Kind != "panel" || first.PanelID != "context-overview" {
		return
	}
	if second.Kind != "panel" || second.PanelID != "agent-network" {
		return
	}
	if layout.Children[0].Weight != 1.5 || layout.Children[1].Weight != 3.5 {
		return
	}
	layout.Children[0].Weight = boardContextRowWeight
	layout.Children[1].Weight = boardNetworkRowWeight
}

func dedupeBoardModulePages(pages []boardPage) []boardPage {
	out := make([]boardPage, 0, len(pages))
	at := map[string]int{}
	for _, page := range pages {
		if page.Kind == "" || page.Kind == fleetPageID {
			out = append(out, page)
			continue
		}
		if position, ok := at[page.Kind]; ok {
			if out[position].Scope == "" && page.Scope != "" {
				out[position] = page
			}
			continue
		}
		at[page.Kind] = len(out)
		out = append(out, page)
	}
	return out
}

func ensureBoardDashboardPanels(page *boardPage) {
	if page.Kind != "" {
		return
	}
	kept := make([]boardPanel, 0, len(page.Panels))
	for _, panel := range page.Panels {
		if panel.Kind == "insights" {
			removeBoardPanelFromLayout(&page.Layout, panel.ID)
			continue
		}
		kept = append(kept, panel)
	}
	page.Panels = kept
	hasTrajectory, hasOverview, hasNetwork := false, false, false
	for _, panel := range page.Panels {
		switch panel.Kind {
		case "trajectory":
			hasTrajectory = true
		case "context-overview":
			hasOverview = true
		case "agent-network":
			hasNetwork = true
		}
	}
	added := []boardPanel{}
	if !hasOverview {
		added = append(added, boardPanel{ID: "context-overview", Kind: "context-overview"})
	}
	if !hasNetwork {
		added = append(added, boardPanel{ID: "agent-network", Kind: "agent-network"})
	}
	if !hasTrajectory {
		added = append(added, boardPanel{ID: "trajectory", Kind: "trajectory"})
	}
	if len(added) == 0 {
		return
	}
	page.Panels = append(page.Panels, added...)
	row := boardNode{Kind: "split", Axis: "row"}
	for _, panel := range added {
		row.Children = append(row.Children, boardSlot{Weight: 1, Node: boardNode{Kind: "panel", PanelID: panel.ID}})
	}
	if page.Layout.Kind == "split" && page.Layout.Axis == "column" {
		page.Layout.Children = append(page.Layout.Children, boardSlot{Weight: 1, Node: row})
	} else {
		page.Layout = boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
			{Weight: 1, Node: page.Layout},
			{Weight: 1, Node: row},
		}}
	}
	normalizeBoardLayout(&page.Layout)
}

func pruneBoardPanels(page *boardPage) {
	live := map[string]bool{}
	for _, id := range boardLeafIDs(&page.Layout) {
		live[id] = true
	}
	if page.Kind != "" {
		return
	}
	kept := make([]boardPanel, 0, len(page.Panels))
	for _, panel := range page.Panels {
		if live[panel.ID] {
			kept = append(kept, panel)
		}
	}
	page.Panels = kept
}

func boardLeafIDs(node *boardNode) []string {
	if node.Kind == "panel" {
		if node.PanelID == "" {
			return nil
		}
		return []string{node.PanelID}
	}
	ids := []string{}
	for index := range node.Children {
		ids = append(ids, boardLeafIDs(&node.Children[index].Node)...)
	}
	return ids
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
	if kind == "insights" {
		page.Panels = []boardPanel{
			{ID: "insights-kpi", Kind: "insights-kpi"},
			{ID: "insights-days", Kind: "insights-days"},
			{ID: "insights-sessions", Kind: "insights-sessions"},
		}
		page.Layout = boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
			{Weight: 1, Node: boardNode{Kind: "split", Axis: "row", Children: []boardSlot{
				{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "insights-kpi"}},
				{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "insights-days"}},
			}}},
			{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "insights-sessions"}},
		}}
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
	case "trajectory":
		s.ensureTrajectory()
	case "insights":
		s.ensureInsights()
	case "fleet", "agent":
		s.ensureFleet()
	case "fleet-graph":
		s.ensureFleetGraph()
	}
}

func (s *shellState) deferBoardDrop(drop func()) {
	s.board.pendingDrop = drop
	s.frame()
}
