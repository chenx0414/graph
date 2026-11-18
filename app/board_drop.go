package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) boardDropPreview(ctx *ui.Context, panel *boardPanel) {
	drag := s.board.drag
	if drag == nil || drag.target != panel.ID {
		return
	}
	t := gwtheme.Of(ctx)
	tint := t.Unread.Alpha(0.18)
	switch drag.edge {
	case "left", "right":
		row := ui.Row(ctx).Fill().IgnoreInput(true)
		row.Children(func() {
			if drag.edge == "left" {
				ui.Box(ctx).Grow(1).FillHeight().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
				ui.Box(ctx).Grow(1).FillHeight()
				return
			}
			ui.Box(ctx).Grow(1).FillHeight()
			ui.Box(ctx).Grow(1).FillHeight().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
		})
	case "top", "bottom":
		column := ui.Column(ctx).Fill().IgnoreInput(true)
		column.Children(func() {
			if drag.edge == "top" {
				ui.Box(ctx).Grow(1).FillWidth().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
				ui.Box(ctx).Grow(1).FillWidth()
				return
			}
			ui.Box(ctx).Grow(1).FillWidth()
			ui.Box(ctx).Grow(1).FillWidth().Background(tint).Border(2, t.Unread).Radius(t.Radius.Md)
		})
	default:
		ui.Box(ctx).Fill().IgnoreInput(true).Background(tint).Border(2, t.Unread).Radius(t.Radius.Xl)
	}
}

func (s *shellState) dragBoardPanel(panel *boardPanel, dx, dy float32) {
	if s.board.drag == nil || s.board.drag.panelID != panel.ID {
		s.board.drag = &boardDrag{panelID: panel.ID}
	}
	s.board.drag.dx += dx
	s.board.drag.dy += dy
	s.updateBoardDragTarget()
}

func (s *shellState) updateBoardDragTarget() {
	drag := s.board.drag
	if drag == nil {
		return
	}
	rect, ok := s.board.rects[drag.panelID]
	if !ok {
		return
	}
	pointX := rect.X + rect.W/2 + drag.dx
	pointY := rect.Y + rect.H/2 + drag.dy
	if s.board.press == drag.panelID {
		pointX = s.board.pressX + drag.dx
		pointY = s.board.pressY + drag.dy
	}
	drag.target, drag.edge = s.boardDropTarget(drag.panelID, pointX, pointY)
}

func (s *shellState) boardDropTarget(sourceID string, pointX, pointY float32) (string, string) {
	for id, target := range s.board.rects {
		if id == sourceID || target.W <= 0 || target.H <= 0 {
			continue
		}
		if pointX < target.X || pointX > target.X+target.W || pointY < target.Y || pointY > target.Y+target.H {
			continue
		}
		return id, boardDropEdge((pointX-target.X)/target.W, (pointY-target.Y)/target.H)
	}
	return "", ""
}

func (s *shellState) dropBoardPanelAt(sourceID string, pointX, pointY float32) {
	drag := s.board.drag
	if drag == nil || drag.panelID != sourceID {
		drag = &boardDrag{panelID: sourceID}
	}
	drag.target, drag.edge = s.boardDropTarget(sourceID, pointX, pointY)
	s.board.drag = drag
	s.dropBoardPanel()
}

func boardDropEdge(x, y float32) string {
	if x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75 {
		return "center"
	}
	edge := "left"
	distance := x
	if 1-x < distance {
		edge, distance = "right", 1-x
	}
	if y < distance {
		edge, distance = "top", y
	}
	if 1-y < distance {
		edge = "bottom"
	}
	return edge
}

func (s *shellState) dropBoardPanel() {
	drag := s.board.drag
	s.board.drag = nil
	s.board.press = ""
	if drag == nil || drag.target == "" {
		return
	}
	page := s.boardPage()
	if drag.edge == "center" {
		swapBoardPanels(&page.Layout, drag.panelID, drag.target)
	} else {
		splitBoardPane(&page.Layout, drag.target, drag.panelID, drag.edge)
	}
	normalizeBoardLayout(&page.Layout)
	pruneBoardPanels(page)
	s.saveBoard()
	s.frame()
}
