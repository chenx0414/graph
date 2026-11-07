package graph

import (
	"fmt"
	"strings"
)

func rsiHasGitComponent(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == ".git" {
			return true
		}
	}
	return false
}

func rsiFirstText(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

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

func RsiChangeShapeHint(args any) string {
	top := rsiPlainObject(args)
	if top == nil {
		return ""
	}
	topLevel := []string{"title", "problem", "evidence", "diagnosis", "impact", "risk", "checks", "activate", "force", "dryRun"}
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
		if _, ok := entry["path"].(string); !ok {
			return "changes[" + itoa(index) + "] is missing \"path\": every change needs one path per file. Write it as " +
				"{path, action: \"write\", content or fromPath} | {path, action: \"replace\", edits: [{oldText, newText}] or fromPath}" +
				" | {path, action: \"copy\", from: \"<revision>\"} | {path, action: \"delete\"}."
		}
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
