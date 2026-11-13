package main

import (
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

func defaultFleetPanels() []boardPanel {
	panels := make([]boardPanel, 0, 6)
	for _, kind := range []string{"fleet-kpi", "fleet-collaboration", "fleet-tasks", "fleet-events", "fleet-artifacts"} {
		panels = append(panels, boardPanel{ID: kind, Kind: kind})
	}
	network := boardPanel{ID: "fleet-network", Kind: "agent-network", Scope: "fleet"}
	panels = append(panels[:1], append([]boardPanel{network}, panels[1:]...)...)
	return panels
}

func defaultFleetLayout() boardNode {
	network := boardSlot{Weight: 3, Node: boardNode{Kind: "panel", PanelID: "fleet-network"}}
	right := boardSlot{Weight: 2, Node: boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
		{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "fleet-collaboration"}},
		{Weight: 1, Node: boardNode{Kind: "panel", PanelID: "fleet-tasks"}},
	}}}
	return boardNode{Kind: "split", Axis: "column", Children: []boardSlot{
		{Weight: 1.15, Node: boardNode{Kind: "panel", PanelID: "fleet-kpi"}},
		{Weight: 4.2, Node: boardNode{Kind: "split", Axis: "row", Children: []boardSlot{network, right}}},
		{Weight: 2.4, Node: boardNode{Kind: "split", Axis: "row", Children: []boardSlot{
			{Weight: 3, Node: boardNode{Kind: "panel", PanelID: "fleet-events"}},
			{Weight: 2, Node: boardNode{Kind: "panel", PanelID: "fleet-artifacts"}},
		}}},
	}}
}

func defaultFleetPage() boardPage {
	return boardPage{
		ID:     fleetPageID,
		Title:  fleetPageTitle,
		Kind:   fleetPageID,
		Panels: defaultFleetPanels(),
		Layout: defaultFleetLayout(),
	}
}

func defaultBoardPage() boardPage {
	return boardPage{ID: "board", Title: boardDefaultTitle, Panels: defaultBoardPanels(), Layout: defaultBoardLayout()}
}

func boardPageClosable(page boardPage) bool {
	return page.ID != fleetPageID && page.Kind != fleetPageID
}

func (s *shellState) pinBoardPages() {
	activeID := ""
	if s.board.active >= 0 && s.board.active < len(s.board.pages) {
		activeID = s.board.pages[s.board.active].ID
	}
	pinned := defaultBoardPage()
	pinnedSet := false
	fleet := defaultFleetPage()
	fleetSet := false
	modules := []boardPage{}
	for _, page := range s.board.pages {
		switch {
		case page.ID == fleetPageID || page.Kind == fleetPageID:
			if !fleetSet {
				fleet = page
				fleetSet = true
			}
		case page.Kind == "":
			if pinnedSet {
				continue
			}
			pinned = page
			pinnedSet = true
		default:
			modules = append(modules, page)
		}
	}
	pinned.ID, pinned.Kind, pinned.Title = "board", "", boardDefaultTitle
	fleet.ID, fleet.Kind, fleet.Title = fleetPageID, fleetPageID, fleetPageTitle
	if fleetSet {
		normalizeBoardLayout(&fleet.Layout)
		if fleet.Layout.Kind == "" || len(fleet.Panels) == 0 {
			fleet = defaultFleetPage()
		}
	}
	pages := make([]boardPage, 0, len(modules)+2)
	pages = append(pages, pinned, fleet)
	pages = append(pages, modules...)
	s.board.pages = pages
	s.board.active = 0
	for index := range pages {
		if activeID != "" && pages[index].ID == activeID {
			s.board.active = index
			break
		}
	}
}

func (s *shellState) resetFleetPage() {
	index := -1
	for current := range s.board.pages {
		if s.board.pages[current].ID == fleetPageID || s.board.pages[current].Kind == fleetPageID {
			index = current
			break
		}
	}
	if index < 0 {
		return
	}
	s.board.pages[index] = defaultFleetPage()
	s.board.rects = map[string]ui.Rect{}
	s.board.splits = map[string]ui.Rect{}
	s.board.active = index
	s.boardScrollTop = true
	s.fleet.netKey = ""
	s.fleet.netScroll = ui.ScrollState{}
	s.fleet.hoverID = ""
	s.ensureBoardPageData()
	s.saveBoard()
	s.frame()
}

func (s *shellState) resetBoardPage() {
	if len(s.board.pages) == 0 {
		return
	}
	s.board.pages[0] = defaultBoardPage()
	s.board.rects = map[string]ui.Rect{}
	s.board.splits = map[string]ui.Rect{}
	s.board.active = 0
	s.boardScrollTop = true
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
	if len(s.board.pages) <= 1 || index <= 0 {
		return
	}
	index = clampIndex(index, len(s.board.pages))
	if !boardPageClosable(s.board.pages[index]) {
		return
	}
	if s.board.active == index {
		s.board.active = 0
	} else if s.board.active > index {
		s.board.active--
	}
	s.board.pages = append(s.board.pages[:index], s.board.pages[index+1:]...)
	s.board.active = clampIndex(s.board.active, len(s.board.pages))
	s.saveBoard()
	s.frame()
}

func fleetAgentPageID(agentID string) string {
	return "agent:" + agentID
}

func fleetAgentIDOfPage(pageID string) string {
	return strings.TrimPrefix(pageID, "agent:")
}

func (s *shellState) openFleetAgentPage(agent fleetAgent) error {
	if agent.ID == "" {
		return nil
	}
	id := fleetAgentPageID(agent.ID)
	for index := range s.board.pages {
		if s.board.pages[index].ID == id {
			s.selectBoardPage(index)
			return nil
		}
	}
	title := fleetAgentLabel(agent)
	page := boardPage{
		ID:     id,
		Title:  title,
		Kind:   "agent",
		Panels: []boardPanel{{ID: "agent-detail", Kind: "agent-detail"}},
		Layout: boardNode{Kind: "panel", PanelID: "agent-detail"},
	}
	s.board.pages = append(s.board.pages, page)
	s.board.active = len(s.board.pages) - 1
	s.ensureBoardPageData()
	s.saveBoard()
	s.frame()
	return nil
}
