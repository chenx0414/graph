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
	names       map[string]string
	args        map[string]ai.JsonObject
	outputs     map[string]string
	compactions map[string]string
	lastEntry   durable.EntryId
}

func liveShapeOf(state *harness.LiveState) liveShape {
	shape := liveShape{tools: map[string]string{}, names: map[string]string{}, args: map[string]ai.JsonObject{}, outputs: map[string]string{}, compactions: map[string]string{}}
	if state == nil {
		return shape
	}
	if state.Run != nil {
		shape.busy = true
		shape.turns = state.Run.Turns
	}
	if state.Generation != nil && state.Generation.Message != nil {
		for _, block := range state.Generation.Message.Content {
			if call, ok := block.(ai.ToolCall); ok {
				shape.names[call.ID] = call.Name
				shape.args[call.ID] = call.Arguments
			}
		}
	}
	for _, slot := range state.Tools {
		shape.tools[slot.CallId] = string(slot.Status)
		if slot.Name != "" {
			shape.names[slot.CallId] = slot.Name
		}
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
				report := map[string]any{"type": "tool_execution_start", "toolCallId": callId}
				if name := liveToolName(previous, next, callId); name != "" {
					report["toolName"] = name
				}
				if args, ok := next.args[callId]; ok && args != nil {
					report["args"] = args
				}
				reports = append(reports, report)
			}
		case string(harness.ToolSlotDone):
			result := map[string]any{"content": []any{}}
			if output := next.outputs[callId]; output != "" {
				result["content"] = []any{map[string]any{"type": "text", "text": output}}
			}
			report := map[string]any{"type": "tool_execution_end", "toolCallId": callId, "isError": false, "result": result}
			if name := liveToolName(previous, next, callId); name != "" {
				report["toolName"] = name
			}
			reports = append(reports, report)
		}
	}
	if previous.busy && !next.busy {
		reports = append(reports, map[string]any{"type": "agent_end"})
	}
	return reports
}

func liveToolName(previous, next liveShape, callId string) string {
	if name := next.names[callId]; name != "" {
		return name
	}
	return previous.names[callId]
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
			next := previous
			if state, err := durable.Snapshot(ctx, session.kernel.Harness(), harness.LiveDoc, session.conversation.Id()); err == nil {
				next = liveShapeOf(state)
			}
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
			next.lastEntry = previous.lastEntry
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

func entryToolReports(messages []ai.Message) []map[string]any {
	reports := []map[string]any{}
	for _, message := range messages {
		switch typed := message.(type) {
		case ai.AssistantMessage:
			for _, block := range typed.Content {
				call, ok := block.(ai.ToolCall)
				if !ok || call.ID == "" {
					continue
				}
				report := map[string]any{"type": "tool_execution_start", "toolCallId": call.ID}
				if call.Name != "" {
					report["toolName"] = call.Name
				}
				if call.Arguments != nil {
					report["args"] = call.Arguments
				}
				reports = append(reports, report)
			}
		case ai.ToolResultMessage:
			if typed.ToolCallID == "" {
				continue
			}
			content := []any{}
			for _, part := range typed.Content {
				if text, ok := part.(ai.TextContent); ok && text.Text != "" {
					content = append(content, map[string]any{"type": "text", "text": text.Text})
				}
			}
			report := map[string]any{
				"type": "tool_execution_end", "toolCallId": typed.ToolCallID, "isError": typed.IsError,
				"result": map[string]any{"content": content},
			}
			if typed.ToolName != "" {
				report["toolName"] = typed.ToolName
			}
			reports = append(reports, report)
		}
	}
	return reports
}

func (session *Session) publishEntries(ctx context.Context, seen *liveShape) {
	if session.conversation == nil {
		return
	}
	if seen.lastEntry == 0 {
		page, err := session.conversation.Entries(ctx, durable.EntryQuery{ConversationId: session.conversation.Id()}, 1, nil)
		if err != nil {
			return
		}
		if len(page.Items) == 0 {
			return
		}
		seen.lastEntry = page.Items[0].Id
		return
	}
	order := durable.ScanAscending
	oldest := seen.lastEntry
	page, err := session.conversation.Entries(ctx, durable.EntryQuery{ConversationId: session.conversation.Id(), MinEntryId: &oldest, Order: &order}, 50, nil)
	if err != nil {
		return
	}
	for _, entry := range page.Items {
		if entry.Id <= seen.lastEntry {
			continue
		}
		seen.lastEntry = entry.Id
		for _, message := range entry.Model {
			if _, ok := message.(ai.AssistantMessage); ok {
				session.OnEvent(map[string]any{"type": "message_end", "message": messageMap(message)})
			}
			for _, report := range entryToolReports([]ai.Message{message}) {
				session.OnEvent(report)
			}
		}
	}
}
