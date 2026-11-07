package pigkernel

import (
	"context"
	"fmt"
	"strings"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)


func (session *Session) Compact(ctx context.Context, instructions string) error {
	return session.CompactWithReason(ctx, instructions, "manual")
}

func (session *Session) CompactWithReason(ctx context.Context, instructions string, reason string) error {
	session.mutex.Lock()
	if session.closed {
		session.mutex.Unlock()
		return fmt.Errorf("pig kernel: the session is closed")
	}
	session.mutex.Unlock()
	var prompt *string
	if instructions != "" {
		value := instructions
		prompt = &value
	}
	task, err := session.conversation.Compact(ctx, prompt)
	if err != nil {
		return err
	}
	session.markCompactionReported(task)
	result, err := session.kernel.Harness().WaitForTask(ctx, task)
	if err != nil {
		return err
	}
	session.reportCompaction(ctx, result, reason)
	if result.State.Outcome != nil && result.State.Outcome.Status != durable.OutcomeCompleted {
		return fmt.Errorf("pig kernel: the compaction did not complete")
	}
	if result.State.Outcome != nil && !compactionCarriesSummary(result.State.Outcome.Result) {
		return fmt.Errorf("Nothing to compact (session too small)")
	}
	return nil
}

func (session *Session) reportCompaction(ctx context.Context, result durable.SettledTask[durable.JsonValue], reason string) {
	if session.OnEvent == nil {
		return
	}
	if reason == "" {
		reason = "manual"
	}
	report := map[string]any{"type": "compaction_end", "reason": reason}
	outcome := result.State.Outcome
	if outcome != nil && outcome.Status == durable.OutcomeCompleted {
		if summary := session.compactionSummary(ctx); summary != "" {
			result := map[string]any{"summary": summary}
			if view, err := session.conversation.Context(ctx, nil); err == nil {
				result["estimatedTokensAfter"] = estimateContextTokens(view.Messages)
			}
			report["result"] = result
			session.OnEvent(report)
			return
		}
		report["aborted"] = true
		report["errorMessage"] = "Nothing to compact (session too small)"
		session.OnEvent(report)
		return
	}
	report["aborted"] = true
	message := "compaction failed"
	if outcome != nil && outcome.Error != nil && outcome.Error.Message != "" {
		message = outcome.Error.Message
	}
	report["errorMessage"] = message
	session.OnEvent(report)
}

func (session *Session) compactionSummary(ctx context.Context) string {
	entries, err := session.conversation.Entries(ctx, durable.EntryQuery{ConversationId: session.conversation.Id()}, 1000, nil)
	if err != nil {
		return ""
	}
	for index := len(entries.Items) - 1; index >= 0; index-- {
		entry := entries.Items[index]
		if entry.Kind != durable.CompactionEntry.Kind {
			continue
		}
		for _, message := range entry.Model {
			user, ok := message.(ai.UserMessage)
			if !ok {
				continue
			}
			blocks, ok := user.Content.(ai.UserContentBlocks)
			if !ok {
				continue
			}
			parts := []string{}
			for _, block := range blocks {
				if text, ok := block.(ai.TextContent); ok {
					parts = append(parts, text.Text)
				}
			}
			return strings.Join(parts, "\n")
		}
	}
	return ""
}

func compactionCarriesSummary(result *any) bool {
	if result == nil || *result == nil {
		return false
	}
	object, ok := (*result).(map[string]any)
	if !ok {
		return false
	}
	for _, key := range []string{"entryId", "submissionId"} {
		if value, found := object[key]; found && value != nil {
			return true
		}
	}
	return false
}

func (session *Session) markCompactionReported(task durable.TaskId) {
	session.mutex.Lock()
	if session.compactions == nil {
		session.compactions = map[durable.TaskId]bool{}
	}
	session.compactions[task] = true
	session.mutex.Unlock()
}

func (session *Session) compactionReported(task durable.TaskId) bool {
	session.mutex.Lock()
	reported := session.compactions[task]
	session.mutex.Unlock()
	return reported
}

func (session *Session) PrepareContext(ctx context.Context, budget int, compactAt int, pending string, instructions string, handoff string) (reset bool, compacted bool, estimated int, err error) {
	if budget <= 0 {
		return false, false, 0, nil
	}
	view, err := session.conversation.Context(ctx, nil)
	if err != nil {
		return false, false, 0, err
	}
	estimated = estimateContextTokens(view.Messages) + int(estimateTextTokens(pending))
	if estimated > budget {
		text := strings.TrimSpace(handoff)
		if text == "" {
			text = fmt.Sprintf("The previous conversation was replaced because it no longer fit the model's context window. "+
				"Its full transcript is durable as conversation %d; use the %s tool to read what you need (search by keyword, "+
				"or read one entry by id), then continue from the user's latest message.", session.conversation.Id(), historyToolName)
		}
		if err := session.conversation.Reset(ctx, &text); err != nil {
			return false, false, estimated, err
		}
		return true, false, estimated, nil
	}
	if compactAt <= 0 || estimated <= compactAt {
		return false, false, estimated, nil
	}
	if err := session.CompactWithReason(ctx, instructions, "threshold"); err != nil {
		return false, false, estimated, nil
	}
	return false, true, estimated, nil
}

func (session *Session) reportThresholdCompaction(event harness.CompactionEndEvent) {
	report := map[string]any{"type": "compaction_end", "reason": string(event.Reason)}
	if event.Error != nil {
		report["aborted"] = true
		report["errorMessage"] = *event.Error
		session.OnEvent(report)
		return
	}
	summary := session.compactionSummary(context.Background())
	if summary == "" {
		report["aborted"] = true
		report["errorMessage"] = "Nothing to compact (session too small)"
		session.OnEvent(report)
		return
	}
	result := map[string]any{"summary": summary}
	if view, err := session.conversation.Context(context.Background(), nil); err == nil {
		result["estimatedTokensAfter"] = estimateContextTokens(view.Messages)
	}
	report["result"] = result
	session.OnEvent(report)
}
