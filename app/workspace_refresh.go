package main

import "reflect"

func (c *chatState) refreshArtifacts() bool {
	var source *conversationChatSource
	onUI(c.window, func() { source, _ = c.source.(*conversationChatSource) })
	if source == nil {
		return false
	}
	payload, err := source.api.get("/api/conversations/" + source.id + "/artifacts")
	if err != nil {
		return false
	}
	rows, err := parseArtifacts(payload)
	if err != nil {
		return false
	}
	changed := false
	onUI(c.window, func() {
		if c.source == source && !reflect.DeepEqual(rows, c.artifacts) {
			c.artifacts = rows
			changed = true
		}
	})
	return changed
}

func (s *shellState) refreshVisibleWorkspace() {
	switch s.activeBoardKind() {
	case "agent-network":
		if page := s.boardPage(); page != nil && (page.Scope == "fleet" || s.panelScope() == "fleet") {
			s.refreshFleet()
			break
		}
		fallthrough
	case "":
		if s.panelOf("agent") != nil || s.panelOf("agent-network") != nil || s.activeBoardKind() == "agent-network" {
			s.refreshFleet()
			if agent, _ := s.chatAgent(); agent != nil && s.panelOf("agent") != nil {
				s.refreshFleetDetail(*agent)
			}
			if s.panelOf("agent-network") != nil {
				if scope := s.chatScope(); scope.Kind == "node" {
					s.refreshNetGraph(scope)
				}
			}
		}
	case "fleet":
		s.refreshFleet()
	case "agent":
		s.refreshFleet()
		if agent, note := s.fleetDetailAgent(fleetAgentIDOfPage(s.boardPage().ID)); note == "" && agent != nil {
			s.refreshFleetDetail(*agent)
		}
	case "fleet-graph":
		s.refreshFleet()
		s.refreshFleetGraph()
	}
}
