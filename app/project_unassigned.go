package main

import (
	"encoding/json"
	"strconv"

	"github.com/egoist/mygo/ui"
)

func (s *shellState) archiveUnassignedChildSessions() {
	go func() {
		body := map[string]any{"requestId": requestID("archive-unassigned")}
		payload, err := s.api.post("/api/conversations/archive-unassigned", body)
		if err != nil {
			onUI(s.window, func() {
				s.status = "归档未归属失败：" + err.Error()
				s.frame()
			})
			return
		}
		var result struct {
			Archived int `json:"archived"`
		}
		_ = json.Unmarshal(payload, &result)
		onUI(s.window, func() {
			s.status = "已归档 " + strconv.Itoa(result.Archived) + " 个未归属子 Agent 会话"
			s.fleet.data = nil
			s.fleet.global = nil
			if s.window != nil {
				s.refreshFleet()
			}
			s.frame()
		})
	}()
}

func (s *shellState) fleetOrphanMenu(card ui.Element) {
	card.ContextMenu(func(m *ui.Menu) {
		if m.Item("归档所有未归属").Chosen() {
			s.archiveUnassignedChildSessions()
		}
	})
}
