package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

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
