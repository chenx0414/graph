package graph

import (
	"fmt"
	"strings"
)

// rsiHasGitComponent reports whether a path names the .git directory.
func rsiHasGitComponent(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == ".git" {
			return true
		}
	}
	return false
}

// rsiFirstText is the first nonempty text.
func rsiFirstText(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// rsiPanicMessage is the message of a recovered failure.
func rsiPanicMessage(recovered any) string {
	switch err := recovered.(type) {
	case *RuntimeError:
		return err.Message
	case error:
		return err.Error()
	default:
		return fmt.Sprint(recovered)
	}
}

// rsiRecord writes the receipt into the conversation and the event log.
func (service *RsiService) rsiRecord(context RsiApplyContext, receipt RsiReceipt) {
	context.Store.Transaction(func() any {
		if receipt.RestartRequired && receipt.Commit != nil && context.OperationId != nil {
			AwaitRsiReload(context.Store, receipt.Id, *context.OperationId, *receipt.Commit)
		}
		context.Store.Event(context.TaskId, "rsi.change", receipt)
		conversationID := ""
		if context.ConversationId != nil {
			conversationID = *context.ConversationId
		} else {
			conversation := ConversationForTask(context.Store, context.TaskId)
			if conversation == nil {
				return nil
			}
			conversationID = conversation.Id
		}
		AppendMessage(context.Store, MessageInput{
			ConversationID: conversationID, Role: "system", Kind: "rsi",
			OperationID: context.OperationId, Text: receipt.Report, Data: receipt, State: "done",
		})
		// Scheduling a reload drains the daemon, which can close the Agent process
		// before the turn settles. The turn's visible receipt is therefore written
		// here, while the reload is only requested, so the user always sees the
		// outcome of the change and never has to ask for it again.
		if receipt.RestartRequired {
			AppendMessage(context.Store, MessageInput{
				ConversationID: conversationID, Role: "assistant", Kind: "chat",
				OperationID: context.OperationId, Text: RSI_RELOAD_RECEIPT,
				Data: map[string]any{"reloadReceipt": true}, State: "done",
			})
			MarkOperationReplied(context.Store, context.OperationId)
		}
		return nil
	})
}

// RsiChangeShapeHint answers the model's own mistakes about the shape of `changes[]`, in its terms.
//
// The SDK validates the call before this service sees it and prints every schema fact it finds
// (`changes.0.path: must have required properties path`, followed by the received arguments) - accurate,
// and never a word about what went wrong: a top-level field nested one level too deep, or a whole change
// written inside `edits[]`. A missing `path` is answered here too: it measured as the single most frequent
// mistake (a `replace` entry carrying `edits` drops it), and the schema's wording never names the entry it
// lost. Everything else that is only a field problem stays the schema's business.
//
// The empty string means the shape is fine.
func RsiChangeShapeHint(args any) string {
	top := rsiPlainObject(args)
	if top == nil {
		return ""
	}
	topLevel := []string{"title", "problem", "evidence", "diagnosis", "impact", "risk", "checks", "activate", "force"}
	changeKeys := []string{"path", "action", "content", "edits", "from", "fromPath"}
	for index, change := range rsiAsArray(top["changes"]) {
		if rsiIsArray(change) {
			return "changes[" + itoa(index) + "] is an array: changes[] holds one object per file - flatten it."
		}
		entry := rsiPlainObject(change)
		if entry == nil {
			continue
		}
		stray := ""
		for _, key := range topLevel {
			if rsiHasOwn(entry, key) {
				stray = key
				break
			}
		}
		if stray != "" {
			return "changes[" + itoa(index) + "] is one file change: {path, action, content, edits}. \"" + stray +
				"\" belongs at the top level of the call - it is nested one level too deep."
		}
		// Every change needs a path, whatever its action. The measured mistake is a `replace` entry that
		// carries `edits` and quietly drops `path`, and the SDK answers only "must have required
		// properties path" - no index, no shape, so the same call comes back. Name it here instead.
		if _, ok := entry["path"].(string); !ok {
			return "changes[" + itoa(index) + "] is missing \"path\": every change needs one path per file. Write it as " +
				"{path, action: \"write\", content or fromPath} | {path, action: \"replace\", edits: [{oldText, newText}] or fromPath}" +
				" | {path, action: \"copy\", from: \"<revision>\"} | {path, action: \"delete\"}."
		}
		// A mirror names a revision instead of retyping content. Shape mistakes in that one field are
		// answered here, before any file is touched, by the same rule the parser enforces.
		if rsiText(entry["action"]) == "copy" {
			if refusal := RevisionRefusal(entry["from"]); refusal != "" {
				return "changes[" + itoa(index) + "].from " + refusal
			}
		}
		for editIndex, edit := range rsiAsArray(entry["edits"]) {
			if rsiIsArray(edit) {
				return "changes[" + itoa(index) + "].edits[" + itoa(editIndex) +
					"] is an array: edits[] holds one {oldText, newText} per edit - flatten it."
			}
			edited := rsiPlainObject(edit)
			if edited == nil {
				continue
			}
			nested := ""
			for _, key := range changeKeys {
				if rsiHasOwn(edited, key) {
					nested = key
					break
				}
			}
			if nested != "" {
				return "changes[" + itoa(index) + "].edits[" + itoa(editIndex) +
					"] is one edit: {oldText, newText}. A change object {path, action, ...} belongs in changes[], not inside edits[] - one change is nested inside another."
			}
		}
	}
	for index, check := range rsiAsArray(top["checks"]) {
		entry := rsiPlainObject(check)
		if entry == nil {
			continue
		}
		for _, key := range changeKeys {
			if rsiHasOwn(entry, key) {
				return "checks[" + itoa(index) + "] is one check: {command, args}. A file change belongs in changes[], not in checks[]."
			}
		}
	}
	return ""
}
