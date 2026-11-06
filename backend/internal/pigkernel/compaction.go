package pigkernel

import (
	"context"
	"fmt"
	"strings"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
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
	return session.CompactWithReason(ctx, instructions, "manual")
}

// CompactWithReason prepares the next operation's prompt and reports why.
//
// A compaction the daemon asks for is manual; one the threshold asks for is
// threshold. The daemon records the reason, so the two never look alike.
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
	// This compaction is reported by Compact itself, so the event stream must
	// not report it a second time when the same task also appears there.
	session.markCompactionReported(task)
	result, err := session.kernel.Harness().WaitForTask(ctx, task)
	if err != nil {
		return err
	}
	session.reportCompaction(ctx, result, reason)
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
			// The daemon shows this compaction to the reader, so it needs the size the
			// context was left at: a summary with no number beside it cannot say whether
			// the compaction was worth anything. Pi's threshold path reports the same
			// number, so both compactions describe themselves alike.
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

// markCompactionReported records a compaction whose end Compact reports.
func (session *Session) markCompactionReported(task durable.TaskId) {
	session.mutex.Lock()
	if session.compactions == nil {
		session.compactions = map[durable.TaskId]bool{}
	}
	session.compactions[task] = true
	session.mutex.Unlock()
}

// compactionReported reports whether Compact already reported this task.
func (session *Session) compactionReported(task durable.TaskId) bool {
	session.mutex.Lock()
	reported := session.compactions[task]
	session.mutex.Unlock()
	return reported
}

// PrepareContext makes the next request fit the model window.
//
// Below compactAt the context is left alone. Above compactAt the kernel
// compacts: the summary replaces the older part of the context before the
// request is sent, so the provider never reads a request that is about to
// overflow. Above budget the context no longer fits even for the summarizer,
// so it is replaced with a pointer to the durable transcript: nothing is lost,
// and the next turn retrieves what it needs with history_search.
//
// The estimate anchors on the last provider-billed usage and estimates only
// the messages after it, the same way the kernel's threshold compaction does.
// JSON bytes were not a token count: escaped HTML and tool results inflated the
// old estimate by 30-170% and reset sessions that still fit.
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
		// A compaction that cannot run (nothing to compact, or a summarizer
		// failure) must not kill the turn: the context still fits the window,
		// the request proceeds, and the failure is already on the event stream.
		return false, false, estimated, nil
	}
	return false, true, estimated, nil
}

// reportThresholdCompaction tells the daemon how the kernel's own compaction
// ended, with the summary it wrote. Pi's threshold compaction is not routed
// through Compact, so without this the daemon sees a compaction start and no
// compaction end: the summary is invisible and a failure cannot be told apart
// from a success.
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
