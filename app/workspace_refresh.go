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
	case "fleet":
		s.refreshFleet()
	case "agent":
		s.refreshFleet()
		if s.fleet.global != nil {
			s.fleet.global = nil
			s.ensureGlobalFleet()
		}
		if !s.fleet.detail.loading {
			s.fleet.detail.entries = nil
			s.fleet.detail.failed = ""
		}
	case "fleet-graph":
		s.refreshFleet()
		if !s.graph.loading {
			s.graphRetry()
		}
	}
}
