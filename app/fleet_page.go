package main

import (
	"strconv"
	"time"

	"github.com/egoist/mygo/ui"
)

func defaultFleetPanels() []boardPanel {
	panels := make([]boardPanel, 0, 6)
	for _, kind := range []string{"fleet-kpi", "fleet-network", "fleet-collaboration", "fleet-tasks", "fleet-events", "fleet-artifacts"} {
		panels = append(panels, boardPanel{ID: kind, Kind: kind})
	}
	return panels
}

func defaultFleetPage() boardPage {
	panels := defaultFleetPanels()
	return boardPage{
		ID:     fleetPageID,
		Title:  fleetPageTitle,
		Kind:   fleetPageID,
		Panels: panels,
		Layout: layoutFromPanels(panels),
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
	modules := []boardPage{}
	for _, page := range s.board.pages {
		switch {
		case page.ID == fleetPageID || page.Kind == fleetPageID:
			continue
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
	pages := make([]boardPage, 0, len(modules)+2)
	pages = append(pages, pinned, defaultFleetPage())
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

func fleetPanelOf(page *boardPage, kind string) *boardPanel {
	for index := range page.Panels {
		if page.Panels[index].Kind == kind {
			return &page.Panels[index]
		}
	}
	return nil
}

func (s *shellState) fleetPageView(ctx *ui.Context, page *boardPage) {
	th := ctx.Theme()
	dashboard := ui.Column(ctx).Fill().Padding(th.Space(2.5)).Gap(th.Space(2.5))
	dashboard.Children(func() {
		kpi := fleetPanelOf(page, "fleet-kpi")
		if kpi != nil {
			band := ui.Column(ctx).FillWidth().Height(th.Space(32))
			band.Children(func() { s.boardPanelView(ctx, kpi, false, false) })
		}
		middle := ui.Row(ctx).FillWidth().Grow(1).Gap(th.Space(2.5))
		middle.Children(func() {
			left := ui.Column(ctx).Grow(3).FillHeight()
			left.Children(func() {
				if panel := fleetPanelOf(page, "fleet-network"); panel != nil {
					s.boardPanelView(ctx, panel, false, false)
				}
			})
			right := ui.Column(ctx).Grow(2).FillHeight().Gap(th.Space(2.5))
			right.Children(func() {
				for _, column := range []struct {
					kind string
					grow float32
				}{{"fleet-collaboration", 3}, {"fleet-tasks", 2}} {
					panel := fleetPanelOf(page, column.kind)
					if panel == nil {
						continue
					}
					cell := ui.Column(ctx).Grow(column.grow).FillWidth()
					cell.Children(func() { s.boardPanelView(ctx, panel, false, false) })
				}
			})
		})
		bottom := ui.Row(ctx).FillWidth().Grow(1).Gap(th.Space(2.5))
		bottom.Children(func() {
			for _, column := range []struct {
				kind string
				grow float32
			}{{"fleet-events", 3}, {"fleet-artifacts", 2}} {
				panel := fleetPanelOf(page, column.kind)
				if panel == nil {
					continue
				}
				cell := ui.Column(ctx).Grow(column.grow).FillHeight()
				cell.Children(func() { s.boardPanelView(ctx, panel, false, false) })
			}
		})
	})
}
