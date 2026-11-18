package main

import (
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"
)

const (
	fleetSwimLaneHeight  = 76
	fleetSwimColumnWidth = 48
	fleetSwimHeadHeight  = 22
	fleetSwimRailWidth   = 240
	fleetSwimMarkSize    = 16
	fleetSwimMarkLimit   = 100
	fleetSwimArrowSize   = 7
)

// fleetSwimArrow is one sender -> receiver connector: TailY sits on the sender
// row, TipY on the receiver row, so the arrowhead always points at the agent
// the event went to.
type fleetSwimArrow struct {
	Column int
	From   int
	To     int
	X      float32
	TailY  float32
	TipY   float32
	Size   float32
}

func (arrow fleetSwimArrow) Downward() bool { return arrow.TipY > arrow.TailY }

func fleetSwimArrowFor(mark fleetSwimMark, laneAt func(int) float32, x float32) fleetSwimArrow {
	return fleetSwimArrow{
		Column: mark.Column, From: mark.From, To: mark.To, X: x,
		TailY: laneAt(mark.From), TipY: laneAt(mark.To), Size: fleetSwimArrowSize,
	}
}

func fleetSwimArrowLayout(from, to, column int, head, laneHeight, top, x float32) fleetSwimArrow {
	laneAt := func(lane int) float32 { return top + head + float32(lane)*laneHeight + laneHeight/2 }
	return fleetSwimArrowFor(fleetSwimMark{Column: column, From: from, To: to}, laneAt, x)
}

type fleetSwimLane struct {
	Agent  fleetAgent
	Accent ui.Color
	Tasks  int
	Events int
}

type fleetSwimColumn struct {
	At    int64
	Count int
}

type fleetSwimMark struct {
	ID     string
	Column int
	From   int
	To     int
	Text   string
	At     int64
	Kind   string
}

type fleetSwimlane struct {
	Lanes       []fleetSwimLane
	Columns     []fleetSwimColumn
	Marks       []fleetSwimMark
	Records     int
	All         bool
	Directional int
	Rescued     int
	Hidden      int
	Total       int
	Truncated   bool
}

func fleetSwimDirectional(event fleetEvent) bool {
	sender := fleetEventSenderID(event)
	return sender != "" && sender != event.AgentID
}

func buildFleetSwimlane(data *fleetSnapshot, query string, newest bool, all bool) fleetSwimlane {
	model := fleetSwimlane{Lanes: []fleetSwimLane{}, Columns: []fleetSwimColumn{}, Marks: []fleetSwimMark{}}
	if data == nil {
		return model
	}
	model.Total = len(data.Events)
	model.Truncated = data.Truncated
	needle := strings.ToLower(strings.TrimSpace(query))
	index := fleetIndex(data)
	named := func(agent fleetAgent) string {
		return strings.ToLower(fleetAgentLabel(agent) + " " + agent.ID + " " + agent.Role)
	}
	matches := func(event fleetEvent) bool {
		if needle == "" {
			return true
		}
		for _, id := range []string{event.AgentID, event.TargetAgentID, event.SenderAgentID} {
			agent, ok := index[id]
			if ok && strings.Contains(named(agent), needle) {
				return true
			}
		}
		return strings.Contains(strings.ToLower(event.Text), needle) || strings.Contains(strings.ToLower(event.Type), needle)
	}
	kept := make([]fleetEvent, 0, len(data.Events))
	for _, event := range data.Events {
		if matches(event) {
			kept = append(kept, event)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].At != kept[j].At {
			return kept[i].At < kept[j].At
		}
		return kept[i].ID < kept[j].ID
	})
	for _, event := range kept {
		if fleetSwimDirectional(event) {
			model.Directional++
		}
	}
	lanes := kept
	shown := kept
	if !all && model.Directional > 0 {
		shown = make([]fleetEvent, 0, model.Directional)
		for _, event := range kept {
			if fleetSwimDirectional(event) {
				shown = append(shown, event)
			}
		}
	}
	if len(shown) > fleetSwimMarkLimit {
		model.Hidden = len(shown) - fleetSwimMarkLimit
		shown = shown[len(shown)-fleetSwimMarkLimit:]
	}
	participants := map[string]bool{}
	for _, event := range shown {
		participants[event.AgentID] = true
		if sender := fleetEventSenderID(event); sender != "" {
			participants[sender] = true
		}
	}
	model.Records = len(shown)
	accent := fleetAccents()
	laneAt := map[string]int{}
	for _, agent := range data.Agents {
		if !participants[agent.ID] {
			continue
		}
		laneAt[agent.ID] = len(model.Lanes)
		model.Lanes = append(model.Lanes, fleetSwimLane{
			Agent:  agent,
			Accent: accent[(len(model.Lanes)+1)%len(accent)],
		})
	}
	for _, event := range lanes {
		if at, ok := laneAt[event.AgentID]; ok {
			model.Lanes[at].Events++
		}
	}
	for _, task := range data.Tasks {
		if at, ok := laneAt[task.OwnerAgentID]; ok {
			model.Lanes[at].Tasks++
		}
	}
	at := map[int64]int{}
	for _, event := range shown {
		column, ok := at[event.At]
		if !ok {
			column = len(model.Columns)
			at[event.At] = column
			model.Columns = append(model.Columns, fleetSwimColumn{At: event.At})
		}
		model.Columns[column].Count++
	}
	if newest {
		for left, right := 0, len(model.Columns)-1; left < right; left, right = left+1, right-1 {
			model.Columns[left], model.Columns[right] = model.Columns[right], model.Columns[left]
		}
	}
	for position := range model.Columns {
		at[model.Columns[position].At] = position
	}
	for _, event := range shown {
		receiver, ok := laneAt[event.AgentID]
		if !ok {
			continue
		}
		from, to := receiver, -1
		if lane, ok := laneAt[fleetEventSenderID(event)]; ok && lane != receiver {
			from, to = lane, receiver
		}
		model.Marks = append(model.Marks, fleetSwimMark{
			ID:     event.ID,
			Column: at[event.At],
			From:   from,
			To:     to,
			Text:   strings.TrimSpace(event.Text),
			At:     event.At,
			Kind:   fleetEventCategory(event),
		})
	}
	sort.SliceStable(model.Marks, func(i, j int) bool {
		if model.Marks[i].Column != model.Marks[j].Column {
			return model.Marks[i].Column < model.Marks[j].Column
		}
		return model.Marks[i].ID < model.Marks[j].ID
	})
	return model
}

func fleetSwimMarkLabel(mark fleetSwimMark, model fleetSwimlane) string {
	from := "未知 Agent"
	if mark.From >= 0 && mark.From < len(model.Lanes) {
		from = fleetAgentLabel(model.Lanes[mark.From].Agent)
	}
	if mark.To < 0 || mark.To >= len(model.Lanes) {
		return from
	}
	return from + " → " + fleetAgentLabel(model.Lanes[mark.To].Agent)
}
