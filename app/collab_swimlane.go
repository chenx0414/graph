package main

import (
	"sort"
	"strings"
	"unicode"
)

type collabSwimlaneEvent struct {
	ID     string
	LaneID string
	From   string
	// FromLabel carries the human-readable sender name collabMessageText
	// already derived (e.g. "项目主管通知"), so the card can name the sender
	// without re-parsing the supervisor envelope from a bare conversation id.
	FromLabel string
	To        string
	Text      string
	CreatedAt int64
	Seq       int64
}

type collabSwimlaneLane struct {
	ID      string
	Name    string
	Initial string
	Model   string
	Tokens  int64
	Cost    float64
	Events  int
	Tasks   int
}

type collabSwimlaneLink struct {
	From  string
	To    string
	Count int
}

type collabSwimlane struct {
	Lanes    []collabSwimlaneLane
	Events   []collabSwimlaneEvent
	Links    []collabSwimlaneLink
	Records  int
	Earliest int64
	Latest   int64
}

func (m collabSwimlane) LaneCount() int { return len(m.Lanes) }

func collabAgentIdentity(message transcriptMessage) string {
	if id := strings.TrimSpace(message.Data.Source.ConversationID); id != "" {
		return id
	}
	if summary := strings.TrimSpace(message.Data.Source.Summary); summary != "" {
		return summary
	}
	if kind := strings.TrimSpace(message.Data.Source.Kind); kind != "" {
		return kind
	}
	return ""
}

func collabAgentName(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "未知 Agent"
	}
	name := strings.TrimPrefix(id, "agent-")
	name = strings.TrimPrefix(name, "supervisor-")
	name = strings.TrimPrefix(name, "peer-")
	if idx := strings.IndexAny(name, "/:·"); idx > 0 {
		name = name[:idx]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return id
	}
	return name
}

func collabAgentInitial(id string) string {
	name := collabAgentName(id)
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return strings.ToUpper(string(r))
		}
	}
	return "?"
}

func collabEventFromMessage(message transcriptMessage, self string) collabSwimlaneEvent {
	from := collabAgentIdentity(message)
	if from == "" {
		from = self
	}
	label, detail := collabMessageText(message)
	text := detail
	if text == "" {
		text = label
	}
	return collabSwimlaneEvent{
		ID:        message.ID,
		LaneID:    from,
		From:      from,
		FromLabel: label,
		To:        self,
		Text:      text,
		CreatedAt: message.CreatedAt,
		Seq:       message.Seq,
	}
}

func buildCollabSwimlane(messages []transcriptMessage, self string) collabSwimlane {
	model := collabSwimlane{
		Lanes:  []collabSwimlaneLane{},
		Events: []collabSwimlaneEvent{},
		Links:  []collabSwimlaneLink{},
	}
	if self == "" {
		self = "self"
	}

	laneIndex := map[string]int{}
	ensureLane := func(id string) int {
		if idx, ok := laneIndex[id]; ok {
			return idx
		}
		idx := len(model.Lanes)
		laneIndex[id] = idx
		model.Lanes = append(model.Lanes, collabSwimlaneLane{
			ID:      id,
			Name:    collabAgentName(id),
			Initial: collabAgentInitial(id),
		})
		return idx
	}

	taskSets := map[string]map[string]bool{}
	linkIndex := map[string]int{}

	for _, message := range messages {
		ensureLane(collabAgentIdentity(message))
	}
	if len(messages) > 0 {
		ensureLane(self)
	}

	for _, message := range messages {
		event := collabEventFromMessage(message, self)
		ensureLane(event.From)
		ensureLane(event.To)
		model.Events = append(model.Events, event)

		idx := laneIndex[event.From]
		// Name the sender's lane with the human label the card already derived
		// ("项目主管通知") rather than the bare conversation id ("p1"). The
		// generic "Agent 消息" label is skipped so ordinary lanes keep their
		// agent name.
		if event.FromLabel != "" && event.FromLabel != "Agent 消息" {
			model.Lanes[idx].Name = event.FromLabel
		}
		model.Lanes[idx].Events++
		task := strings.TrimSpace(message.Data.Source.TaskID)
		if task != "" {
			if taskSets[event.From] == nil {
				taskSets[event.From] = map[string]bool{}
			}
			if !taskSets[event.From][task] {
				taskSets[event.From][task] = true
				model.Lanes[idx].Tasks++
			}
		}

		linkKey := event.From + ">" + event.To
		if pos, ok := linkIndex[linkKey]; ok {
			model.Links[pos].Count++
		} else {
			linkIndex[linkKey] = len(model.Links)
			model.Links = append(model.Links, collabSwimlaneLink{From: event.From, To: event.To, Count: 1})
		}
	}

	sort.SliceStable(model.Events, func(i, j int) bool {
		a, b := model.Events[i], model.Events[j]
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		if a.Seq != b.Seq {
			return a.Seq < b.Seq
		}
		return a.ID < b.ID
	})

	model.Records = len(model.Events)
	if len(model.Events) > 0 {
		model.Earliest = model.Events[0].CreatedAt
		model.Latest = model.Events[0].CreatedAt
		for _, event := range model.Events[1:] {
			if event.CreatedAt < model.Earliest {
				model.Earliest = event.CreatedAt
			}
			if event.CreatedAt > model.Latest {
				model.Latest = event.CreatedAt
			}
		}
	}
	return model
}

func filterCollabSwimlane(model collabSwimlane, query string) collabSwimlane {
	query = strings.TrimSpace(strings.ToLower(query))
	if query == "" {
		return model
	}
	filtered := collabSwimlane{
		Lanes:  []collabSwimlaneLane{},
		Events: []collabSwimlaneEvent{},
		Links:  []collabSwimlaneLink{},
	}
	laneIndex := map[string]int{}
	linkIndex := map[string]int{}
	ensureLane := func(id string) {
		if _, ok := laneIndex[id]; ok {
			return
		}
		laneIndex[id] = len(filtered.Lanes)
		for _, lane := range model.Lanes {
			if lane.ID == id {
				filtered.Lanes = append(filtered.Lanes, lane)
				return
			}
		}
		filtered.Lanes = append(filtered.Lanes, collabSwimlaneLane{ID: id, Name: collabAgentName(id), Initial: collabAgentInitial(id)})
	}
	for _, event := range model.Events {
		if !strings.Contains(strings.ToLower(event.Text), query) &&
			!strings.Contains(strings.ToLower(event.From), query) &&
			!strings.Contains(strings.ToLower(event.To), query) {
			continue
		}
		ensureLane(event.From)
		ensureLane(event.To)
		filtered.Events = append(filtered.Events, event)
		static := filtered.Lanes[laneIndex[event.From]]
		static.Events++
		filtered.Lanes[laneIndex[event.From]] = static

		linkKey := event.From + ">" + event.To
		if pos, ok := linkIndex[linkKey]; ok {
			filtered.Links[pos].Count++
		} else {
			linkIndex[linkKey] = len(filtered.Links)
			filtered.Links = append(filtered.Links, collabSwimlaneLink{From: event.From, To: event.To, Count: 1})
		}
	}
	filtered.Records = len(filtered.Events)
	if len(filtered.Events) > 0 {
		filtered.Earliest = filtered.Events[0].CreatedAt
		filtered.Latest = filtered.Events[0].CreatedAt
		for _, event := range filtered.Events[1:] {
			if event.CreatedAt < filtered.Earliest {
				filtered.Earliest = event.CreatedAt
			}
			if event.CreatedAt > filtered.Latest {
				filtered.Latest = event.CreatedAt
			}
		}
	}
	return filtered
}
