package pigkernel

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)

const livePollInterval = 200 * time.Millisecond

type liveShape struct {
	busy        bool
	turns       int
	tools       map[string]string
	outputs     map[string]string
	compactions map[string]string
	lastEntry   durable.EntryId
}

func liveShapeOf(state *harness.LiveState) liveShape {
	shape := liveShape{tools: map[string]string{}, outputs: map[string]string{}, compactions: map[string]string{}}
	if state == nil {
		return shape
	}
	if state.Run != nil {
		shape.busy = true
		shape.turns = state.Run.Turns
	}
	for _, slot := range state.Tools {
		shape.tools[slot.CallId] = string(slot.Status)
		if slot.Output != nil {
			shape.outputs[slot.CallId] = *slot.Output
		}
	}
	for _, compaction := range state.Compactions {
		shape.compactions[strconv.FormatInt(int64(compaction.TaskId), 10)] = string(compaction.Trigger)
	}
	return shape
}

func diffLive(previous, next liveShape) []map[string]any {
	reports := []map[string]any{}
	if !previous.busy && next.busy {
		reports = append(reports, map[string]any{"type": "agent_start"})
	}
	if next.turns > previous.turns {
		reports = append(reports, map[string]any{"type": "turn_start"})
	}
	for callId, status := range next.tools {
		before, known := previous.tools[callId]
		if known && before == status {
			continue
		}
		switch status {
		case string(harness.ToolSlotPending), string(harness.ToolSlotRunning):
			if !known {
				reports = append(reports, map[string]any{"type": "tool_execution_start", "toolCallId": callId})
			}
		case string(harness.ToolSlotDone):
			result := map[string]any{"content": []any{}}
			if output := next.outputs[callId]; output != "" {
				result["content"] = []any{map[string]any{"type": "text", "text": output}}
			}
			reports = append(reports, map[string]any{"type": "tool_execution_end", "toolCallId": callId, "isError": false, "result": result})
		}
	}
	if previous.busy && !next.busy {
		reports = append(reports, map[string]any{"type": "agent_end"})
	}
	return reports
}

func startedCompactions(previous, next liveShape) []string {
	reasons := []string{}
	for key, reason := range next.compactions {
		if _, known := previous.compactions[key]; !known {
			reasons = append(reasons, reason)
		}
	}
	return reasons
}

func finishedCompactions(previous, next liveShape) []string {
	reasons := []string{}
	for key, reason := range previous.compactions {
		if _, kept := next.compactions[key]; !kept {
			reasons = append(reasons, reason)
		}
	}
	return reasons
}

func (session *Session) watchLive(ctx context.Context) func() {
	if session.OnEvent == nil {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		previous := liveShape{}
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-time.After(livePollInterval):
			}
			state, err := durable.Snapshot(ctx, session.kernel.Harness(), harness.LiveDoc, session.conversation.Id())
			if err != nil {
				continue
			}
			next := liveShapeOf(state)
			for _, report := range diffLive(previous, next) {
				session.OnEvent(report)
			}
			for _, reason := range startedCompactions(previous, next) {
				session.OnEvent(map[string]any{"type": "compaction_start", "reason": reason})
			}
			for _, reason := range finishedCompactions(previous, next) {
				session.reportCompactionEnd(reason, "")
			}
			session.publishEntries(ctx, &previous)
			previous = next
		}
	}()
	return func() {
		close(stop)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}

func messageMap(message ai.Message) map[string]any {
	body, err := json.Marshal(message)
	if err != nil {
		return map[string]any{}
	}
	decoded := map[string]any{}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return map[string]any{}
	}
	return decoded
}

func (session *Session) publishEntries(ctx context.Context, seen *liveShape) {
	query := durable.EntryQuery{ConversationId: session.conversation.Id()}
	if seen.lastEntry > 0 {
		oldest := seen.lastEntry
		query.MinEntryId = &oldest
	}
	page, err := session.conversation.Entries(ctx, query, 50, nil)
	if err != nil {
		return
	}
	for _, entry := range page.Items {
		if entry.Id < seen.lastEntry {
			continue
		}
		if entry.Id > seen.lastEntry {
			seen.lastEntry = entry.Id
		}
		for _, message := range entry.Model {
			if _, ok := message.(ai.AssistantMessage); !ok {
				continue
			}
			session.OnEvent(map[string]any{"type": "message_end", "message": messageMap(message)})
		}
	}
}
