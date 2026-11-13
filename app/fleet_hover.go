package main

import (
	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const (
	fleetHoverStroke     = 2
	fleetRestStroke      = gwtheme.Stroke
	fleetRestBorderAlpha = 0.45
	fleetHoverEdgeWidth  = 2
	fleetHoverEdgeAlpha  = 0.95
	fleetDimEdgeAlpha    = 0.05
	fleetDimOpacity      = 0.45
)

func fleetEdgePaint(from, to, hoverID string, restWidth, restAlpha float32) (float32, float32) {
	switch {
	case hoverID == "":
		return restWidth, restAlpha
	case from == hoverID || to == hoverID:
		return fleetHoverEdgeWidth, fleetHoverEdgeAlpha
	}
	return restWidth, fleetDimEdgeAlpha
}

func (s *shellState) fleetHoverScope(scope string) {
	if s.fleet.hoverScope == scope {
		return
	}
	s.fleet.hoverScope, s.fleet.hoverID = scope, ""
}

func (s *shellState) fleetHoverCard(card ui.Element, id string, accent ui.Color, t gwtheme.Tokens) {
	if card.Hovered() && s.fleet.hoverID != id {
		s.fleet.hoverID = id
		s.frame()
	}
	if s.fleet.hoverID == id {
		card.Background(t.Hover).Border(fleetHoverStroke, accent)
		return
	}
	card.Border(fleetRestStroke, accent.Alpha(fleetRestBorderAlpha))
	if s.fleet.hoverID != "" {
		card.Opacity(fleetDimOpacity)
	}
}
