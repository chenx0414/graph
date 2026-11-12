package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type boardPanel struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Slot int    `json:"slot,omitempty"`
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
	Panels []boardPanel `json:"panels"`
	Layout boardNode    `json:"layout"`
}

type boardFile struct {
	Version int          `json:"version"`
	Panels  []boardPanel `json:"panels,omitempty"`
	Pages   []boardPage  `json:"pages,omitempty"`
	Active  int          `json:"active"`
}

const boardLayoutVersion = 4

const boardDefaultTitle = "白板"

const boardMinPaneWidth = 140

const boardMinPaneHeight = 90

func defaultBoardPanels() []boardPanel {
	return []boardPanel{
		{ID: "overview", Kind: "overview"},
		{ID: "tasks", Kind: "tasks"},
		{ID: "artifacts", Kind: "artifacts"},
	}
}

func defaultBoardLayout() boardNode {
	return boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
		{Weight: 1, Node: boardNode{Kind: "split", Axis: "row", Children: []boardSlot{
			{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "overview"}},
			{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "tasks"}},
		}}},
		{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "artifacts"}},
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
	return []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: defaultBoardPanels(), Layout: defaultBoardLayout()}}
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
	case "trajectory-context":
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
	kept := make([]boardPage, 0, len(file.Pages))
	for _, page := range file.Pages {
		if page.Kind == "history" || page.Kind == "conversation" {
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
		page := &s.board.pages[index]
		if page.Kind == "" {
			kept := make([]boardPanel, 0, len(page.Panels))
			for _, panel := range page.Panels {
				if panel.Kind == "history" || panel.Kind == "conversation" {
					removeBoardPanelFromLayout(&page.Layout, panel.ID)
					continue
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
	}
	s.board.active = clampIndex(file.Active, len(s.board.pages))
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
	for index := range s.board.pages {
		if s.board.pages[index].Kind == kind {
			s.selectBoardPage(index)
			return
		}
	}
	title := boardPanelTitle(kind)
	page := boardPage{
		ID:    "tab-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Title: title,
		Kind:  kind,
		Panels: []boardPanel{
			{ID: kind, Kind: kind},
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
		kinds := []string{"trajectory-summary", "trajectory-tokens", "trajectory-timing", "trajectory-context",
			"trajectory-trend", "trajectory-events", "trajectory-commands", "trajectory-files",
			"trajectory-composition", "trajectory-requests", "trajectory-agents", "trajectory-request-detail"}
		panels := make([]boardPanel, 0, len(kinds))
		for _, panelKind := range kinds {
			panels = append(panels, boardPanel{ID: panelKind, Kind: panelKind})
		}
		page.Panels = panels
		rows := []boardSlot{}
		for row := 0; row*2 < len(kinds); row++ {
			cells := []boardSlot{}
			for column := 0; column < 2 && row*2+column < len(kinds); column++ {
				cells = append(cells, boardSlot{Weight: 1, Node: boardNode{Kind: "panel", PanelID: kinds[row*2+column]}})
			}
			rows = append(rows, boardSlot{Weight: 1, Node: boardNode{Kind: "split", Axis: "row", Children: cells}})
		}
		page.Layout = boardNode{Kind: "split", Axis: "column", Children: rows}
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
		Layout: defaultBoardLayout(),
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
	removeBoardPanelFromLayout(&page.Layout, id)
	normalizeBoardLayout(&page.Layout)
	pruneBoardPanels(page)
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
	case "trajectory":
		s.ensureTrajectory()
	case "insights":
		s.ensureInsights()
	}
}

func normalizeBoardLayout(node *boardNode) {
	if node.Kind != "split" {
		return
	}
	for index := range node.Children {
		normalizeBoardLayout(&node.Children[index].Node)
	}
	kept := make([]boardSlot, 0, len(node.Children))
	for _, slot := range node.Children {
		child := slot.Node
		if child.Kind == "split" {
			switch {
			case len(child.Children) == 0:
				continue
			case len(child.Children) == 1:
				inner := child.Children[0]
				slot.Node = inner.Node
				slot.Weight *= inner.Weight
				kept = append(kept, slot)
				continue
			case child.Axis == node.Axis:
				for _, inner := range child.Children {
					inner.Weight *= slot.Weight
					kept = append(kept, inner)
				}
				continue
			}
		}
		kept = append(kept, slot)
	}
	node.Children = kept
	if len(node.Children) == 1 {
		*node = node.Children[0].Node
	}
	if node.Kind == "split" {
		for index := range node.Children {
			if node.Children[index].Weight <= 0 {
				node.Children[index].Weight = 1
			}
		}
	}
}

func removeBoardPanelFromLayout(node *boardNode, panelID string) {
	if node.Kind != "split" {
		return
	}
	kept := make([]boardSlot, 0, len(node.Children))
	for _, slot := range node.Children {
		if slot.Node.Kind == "panel" && slot.Node.PanelID == panelID {
			continue
		}
		removeBoardPanelFromLayout(&slot.Node, panelID)
		kept = append(kept, slot)
	}
	node.Children = kept
}

func findBoardLeaf(node *boardNode, panelID string) *boardNode {
	if node.Kind == "panel" {
		if node.PanelID == panelID {
			return node
		}
		return nil
	}
	for index := range node.Children {
		if found := findBoardLeaf(&node.Children[index].Node, panelID); found != nil {
			return found
		}
	}
	return nil
}

func findBoardSplit(node *boardNode, axis string, panelID string) *boardNode {
	if node.Kind != "split" {
		return nil
	}
	for index := range node.Children {
		if node.Children[index].Node.Kind == "panel" && node.Children[index].Node.PanelID == panelID && node.Axis == axis {
			return node
		}
	}
	for index := range node.Children {
		if found := findBoardSplit(&node.Children[index].Node, axis, panelID); found != nil {
			return found
		}
	}
	return nil
}

func splitBoardPane(root *boardNode, targetID, sourceID, edge string) bool {
	removeBoardPanelFromLayout(root, sourceID)
	normalizeBoardLayout(root)
	target := findBoardLeaf(root, targetID)
	if target == nil {
		return false
	}
	axis := "row"
	before := edge == "left" || edge == "top"
	if edge == "top" || edge == "bottom" {
		axis = "column"
	}
	source := boardNode{Kind: "panel", PanelID: sourceID}
	existing := *target
	children := []boardSlot{{Weight: 1, Node: existing}, {Weight: 1, Node: source}}
	if before {
		children[0], children[1] = children[1], children[0]
	}
	*target = boardNode{Kind: "split", Axis: axis, Children: children}
	normalizeBoardLayout(root)
	return true
}

func swapBoardPanels(root *boardNode, first, second string) {
	firstLeaf := findBoardLeaf(root, first)
	secondLeaf := findBoardLeaf(root, second)
	if firstLeaf == nil || secondLeaf == nil {
		return
	}
	firstLeaf.PanelID, secondLeaf.PanelID = secondLeaf.PanelID, firstLeaf.PanelID
}
