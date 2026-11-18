package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"
)

// historyGraph is one graph/task as returned by /api/tasks. Unlike the fleet
// snapshot it includes terminal phases (completed/stopped/failed) so the user
// can browse the whole history of a project, not only what is running now.
type historyGraph struct {
	ID             string `json:"id"`
	ProjectID      string `json:"projectId"`
	Request        string `json:"request"`
	Phase          string `json:"phase"`
	Status         string `json:"status"`
	ConversationID string `json:"conversationId"`
	CreatedAt      int64  `json:"createdAt"`
	UpdatedAt      int64  `json:"updatedAt"`
	OpenQuestions  int    `json:"openQuestions"`
}

type fleetHistoryState struct {
	projectID  string
	loading    bool
	failed     string
	tasks      []historyGraph
	generation int
}

func parseHistoryGraphs(payload []byte) ([]historyGraph, error) {
	tasks := []historyGraph{}
	if err := json.Unmarshal(payload, &tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}

// historyGraphProjects lists distinct project ids with the unassigned bucket
// first and the rest in stable alphabetical order.
func historyGraphProjects(tasks []historyGraph) []string {
	seen := map[string]bool{}
	projects := []string{}
	for _, task := range tasks {
		if seen[task.ProjectID] {
			continue
		}
		seen[task.ProjectID] = true
		projects = append(projects, task.ProjectID)
	}
	sort.SliceStable(projects, func(i, j int) bool {
		if projects[i] == "" {
			return true
		}
		if projects[j] == "" {
			return false
		}
		return projects[i] < projects[j]
	})
	return projects
}

// historyGraphsOfProject returns every task of one project, newest first. It
// deliberately has no limit -- the whole point of the history browser is to
// move past the 12-row cut of the live fleet panel.
func historyGraphsOfProject(tasks []historyGraph, projectID string) []historyGraph {
	filtered := make([]historyGraph, 0, len(tasks))
	for _, task := range tasks {
		if task.ProjectID == projectID {
			filtered = append(filtered, task)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].UpdatedAt > filtered[j].UpdatedAt
	})
	return filtered
}

func historyGraphTitle(task historyGraph) string {
	if title := strings.TrimSpace(task.Request); title != "" {
		runes := []rune(title)
		if len(runes) > 28 {
			return string(runes[:28]) + "…"
		}
		return string(runes)
	}
	return task.ID
}

func fleetHistoryPageID(projectID string) string {
	return "history:" + projectID
}

func fleetHistoryProjectOfPage(pageID string) string {
	return strings.TrimPrefix(pageID, "history:")
}

// openFleetHistoryPage opens (or focuses) the full history browser for a
// project. It is a board page like the fleet page, so it can be pinned, closed
// and laid out the same way.
func (s *shellState) openFleetHistoryPage(projectID string) {
	id := fleetHistoryPageID(projectID)
	for index := range s.board.pages {
		if s.board.pages[index].ID == id {
			s.selectBoardPage(index)
			return
		}
	}
	title := "历史图"
	if projectID != "" {
		title = "历史图 · " + projectID
	}
	s.board.pages = append(s.board.pages, boardPage{
		ID: id, Title: title, Kind: "fleet-history", Scope: projectID,
		Panels: []boardPanel{{ID: "fleet-history-list", Kind: "fleet-history-list", Scope: projectID}},
		Layout: boardNode{Kind: "panel", PanelID: "fleet-history-list"},
	})
	s.board.active = len(s.board.pages) - 1
	s.boardScrollTop = true
	s.ensureBoardPageData()
	s.saveBoard()
	s.frame()
}

// ensureFleetHistory loads every task once per history page. It reuses the
// /api/tasks contract already used by the notification system so no new
// backend endpoint is required for the list itself.
func (s *shellState) ensureFleetHistory() {
	if s.conversationDataBlocked() {
		return
	}
	page := s.boardPage()
	if page == nil || page.Kind != "fleet-history" {
		return
	}
	projectID := fleetHistoryProjectOfPage(page.ID)
	state := &s.fleetHistory
	if state.projectID == projectID && (state.tasks != nil || state.loading) {
		return
	}
	state.projectID = projectID
	state.loading = true
	state.failed = ""
	state.tasks = nil
	state.generation++
	generation := state.generation
	api := s.api
	go func() {
		payload, err := api.get("/api/tasks")
		var tasks []historyGraph
		if err == nil {
			tasks, err = parseHistoryGraphs(payload)
		}
		s.updates.post(s.window, func() {
			if s.fleetHistory.generation != generation || s.fleetHistory.projectID != projectID || s.api != api {
				return
			}
			s.fleetHistory.loading = false
			if err != nil {
				s.fleetHistory.failed = "读不到历史图：" + err.Error()
				return
			}
			s.fleetHistory.tasks = tasks
		})
	}()
}

func (s *shellState) refreshFleetHistory() {
	state := &s.fleetHistory
	state.projectID = ""
	state.tasks = nil
	state.loading = false
	s.ensureFleetHistory()
}

// openHistoryGraph turns a history row into the existing graph topology page,
// where the user can drill into nodes and jump to the matching session.
func (s *shellState) openHistoryGraph(task historyGraph) {
	if strings.TrimSpace(task.ID) == "" {
		return
	}
	unit := fleetGraphUnit{TaskID: task.ID, Title: historyGraphTitle(task), Status: task.Status}
	_ = s.openFleetGraphPage(unit)
}

// openHistoryGraphSession jumps from a history row to its conversation. The
// task id is kept in the URL path for node-level sessions; the conversation
// id is the stable session key the shell already switches on.
func (s *shellState) openHistoryGraphSession(task historyGraph) {
	if task.ConversationID != "" {
		s.selectConversation(task.ConversationID)
		return
	}
	if task.ID != "" {
		_ = s.openFleetGraphPage(fleetGraphUnit{TaskID: task.ID, Title: historyGraphTitle(task)})
	}
}

func historyGraphAPIStatus(task historyGraph) string {
	if raw := strings.TrimSpace(task.Status); raw != "" {
		return raw
	}
	return task.Phase
}

func historyGraphPathSegment(value string) string {
	return url.PathEscape(value)
}
