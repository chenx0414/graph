package pigkernel

import (
	"context"
	"fmt"
	"strings"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
)

// The compaction of one session.
//
// The daemon decides when a context is compacted and how much room the
// summary is written in; the kernel writes the summary into that room and
// keeps the recent window the daemon chose. The bridge reports how the
// compaction ended, because a compaction that compacted nothing and a
// compaction that failed are two different facts and the daemon has to be
// able to tell them apart.

// Compact prepares the next operation's prompt.
func (session *Session) Compact(ctx context.Context, instructions string) error {
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
	result, err := session.kernel.Harness().WaitForTask(ctx, task)
	if err != nil {
		return err
	}
	session.reportCompaction(ctx, result)
	if result.State.Outcome != nil && result.State.Outcome.Status != durable.OutcomeCompleted {
		return fmt.Errorf("pig kernel: the compaction did not complete")
	}
	// A compaction that compacted nothing is not a compaction. The kernel
	// completes such a task with an empty result, and Pi reports it as an
	// error, so the daemon is told the truth instead of announcing a context
	// that is exactly as long as it was.
	if result.State.Outcome != nil && !compactionCarriesSummary(result.State.Outcome.Result) {
		return fmt.Errorf("Nothing to compact (session too small)")
	}
	return nil
}

// reportCompaction tells the daemon how the compaction ended.
//
// The kernel's own event carries the reason and the failure. The summary is
// written into the conversation, so it is read there: the daemon persists it
// as the entry that carries the compacted context forward. Without this the
// daemon's compaction handling never runs, and a compaction that failed is
// invisible.
func (session *Session) reportCompaction(ctx context.Context, result durable.SettledTask[durable.JsonValue]) {
	if session.OnEvent == nil {
		return
	}
	report := map[string]any{"type": "compaction_end", "reason": "manual"}
	outcome := result.State.Outcome
	if outcome != nil && outcome.Status == durable.OutcomeCompleted {
		if summary := session.compactionSummary(ctx); summary != "" {
			report["result"] = map[string]any{"summary": summary}
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

// compactionSummary reads the summary the last compaction wrote.
//
// The summary is the compaction entry's own user message: the text the model
// wrote is the whole content of the context that follows it.
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

// compactionCarriesSummary reports whether a compaction wrote a summary.
//
// The result names the entry the summary was written as, or the submission
// that carries it. A compaction with neither compacted nothing.
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
