package graph

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

func RevisionRefusal(from any) string {
	rev := ""
	if text, ok := from.(string); ok {
		rev = strings.TrimSpace(text)
	}
	if rev == "" {
		return "must name the revision to copy the file from (for a mirror: the commit that holds the finished file)"
	}
	if utf8.RuneCountInString(rev) > 200 || strings.Contains(rev, ":") || strings.HasPrefix(rev, "-") || rsiHasWhitespace(rev) {
		return "must be a revision only - \"" + rev + "\" carries something else (a path belongs in \"path\", not in the revision)"
	}
	return ""
}

func rsiAssertText(value any, name string, max int, required bool) string {
	text := ""
	if typed, ok := value.(string); ok {
		text = strings.TrimSpace(typed)
	}
	if required && text == "" {
		Raise("invalid_input", name+" is required")
	}
	if utf8.RuneCountInString(text) > max {
		Raise("invalid_input", fmt.Sprintf("%s must be at most %d characters", name, max))
	}
	return text
}

func rsiChangePath(body map[string]any) any {
	if value, ok := body["path"]; ok && value != nil {
		return value
	}
	if value, ok := body["file"]; ok && value != nil {
		return value
	}
	if value, ok := body["filePath"]; ok && value != nil {
		return value
	}
	return nil
}

func rsiChangePathText(body map[string]any, index int) string {
	path := strings.TrimSpace(rsiText(rsiChangePath(body)))
	if path == "" {
		Raise("invalid_input", fmt.Sprintf(
			"changes[%d].path is required: each change is {path, action: \"write\", content} | {path, action: \"replace\", edits: [{oldText, newText}]} | {path, action: \"delete\"}", index))
	}
	if utf8.RuneCountInString(path) > 1000 {
		Raise("invalid_input", fmt.Sprintf("changes[%d].path must be at most 1000 characters", index))
	}
	return path
}

func rsiFromPath(value any, index int) (string, bool) {
	if value == nil {
		return "", false
	}
	text, ok := value.(string)
	if !ok {
		Raise("invalid_input", fmt.Sprintf("changes[%d].fromPath must be a string", index))
	}
	text = strings.TrimSpace(text)
	if text == "" {
		Raise("invalid_input", fmt.Sprintf("changes[%d].fromPath must name a file already written in the checkout", index))
	}
	if utf8.RuneCountInString(text) > 1000 {
		Raise("invalid_input", fmt.Sprintf("changes[%d].fromPath must be at most 1000 characters", index))
	}
	if filepath.IsAbs(text) || rsiHasGitComponent(text) {
		Raise("invalid_input", fmt.Sprintf("changes[%d].fromPath must stay inside the Graph source root and must not target .git", index))
	}
	return text, true
}

func rsiNormalizeChange(value any, index int) RsiFileChange {
	body := rsiPlainObject(value)
	if body == nil {
		Raise("invalid_input", fmt.Sprintf("changes[%d] must be an object", index))
	}
	path := rsiChangePathText(body, index)
	action := rsiText(body["action"])
	fromPath, hasFromPath := rsiFromPath(body["fromPath"], index)
	if hasFromPath && (action == "copy" || action == "delete") {
		Raise("invalid_input", fmt.Sprintf("changes[%d].fromPath is only for write or replace: %q carries no content", index, action))
	}
	switch action {
	case "write":
		rawContent, present := body["content"]
		if hasFromPath && present && rawContent != nil {
			Raise("invalid_input", fmt.Sprintf("changes[%d] has both content and fromPath: give the new text once - inline content, or fromPath naming a file already written", index))
		}
		if hasFromPath {
			return RsiFileChange{Path: path, Action: "write", FromPath: &fromPath}
		}
		content, ok := rawContent.(string)
		if !ok {
			if !present || rawContent == nil {
				Raise("invalid_input", fmt.Sprintf(
					"changes[%d].content or changes[%d].fromPath is required: a write needs the new text, inline or from a file already written", index, index))
			}
			Raise("invalid_input", fmt.Sprintf("changes[%d].content must be a string", index))
		}
		return RsiFileChange{Path: path, Action: "write", Content: &content}
	case "copy":
		if refusal := RevisionRefusal(body["from"]); refusal != "" {
			Raise("invalid_input", fmt.Sprintf("changes[%d].from %s", index, refusal))
		}
		from := strings.TrimSpace(rsiText(body["from"]))
		return RsiFileChange{Path: path, Action: "copy", From: &from}
	case "delete":
		return RsiFileChange{Path: path, Action: "delete"}
	}
	if action != "replace" {
		Raise("invalid_input", fmt.Sprintf("changes[%d] must be write, replace, copy or delete", index))
	}
	rawEdits, hasEdits := rsiAsArrayOf(body["edits"])
	if hasFromPath && hasEdits {
		Raise("invalid_input", fmt.Sprintf("changes[%d] has both edits and fromPath: a replace is either the edits that change it or a whole file read from fromPath", index))
	}
	if hasFromPath {
		return RsiFileChange{Path: path, Action: "replace", FromPath: &fromPath}
	}
	if !hasEdits || len(rawEdits) == 0 {
		Raise("invalid_input", fmt.Sprintf("changes[%d] must be write, replace, copy or delete", index))
	}
	edits := []RsiFileEdit{}
	for editIndex, rawEdit := range rawEdits {
		record := rsiPlainObject(rawEdit)
		if record == nil {
			Raise("invalid_input", fmt.Sprintf("changes[%d].edits[%d] must be an object", index, editIndex))
		}
		oldText, ok := record["oldText"].(string)
		if !ok || oldText == "" {
			Raise("invalid_input", fmt.Sprintf("changes[%d].edits[%d].oldText must be nonempty", index, editIndex))
		}
		newText, ok := record["newText"].(string)
		if !ok {
			Raise("invalid_input", fmt.Sprintf("changes[%d].edits[%d].newText must be a string", index, editIndex))
		}
		edits = append(edits, RsiFileEdit{OldText: oldText, NewText: newText})
	}
	return RsiFileChange{Path: path, Action: "replace", Edits: edits}
}

func rsiNormalizeChecks(value any, present bool) []RsiCommand {
	if !present {
		return []RsiCommand{}
	}
	if value == nil {
		Raise("invalid_input", "checks must be an array")
	}
	items, ok := rsiAsArrayOf(value)
	if !ok {
		Raise("invalid_input", "checks must be an array")
	}
	checks := []RsiCommand{}
	for index, item := range items {
		record := rsiPlainObject(item)
		if record == nil {
			Raise("invalid_input", fmt.Sprintf("checks[%d] must be an object", index))
		}
		command := rsiText(record["command"])
		switch command {
		case "go", "python3", "node":
		default:
			Raise("invalid_input", fmt.Sprintf("checks[%d].command must be go, python3 or node", index))
		}
		rawArgs, ok := rsiAsArrayOf(record["args"])
		if !ok {
			Raise("invalid_input", fmt.Sprintf("checks[%d].args must be a string array", index))
		}
		args := []string{}
		for _, rawArg := range rawArgs {
			text, ok := rawArg.(string)
			if !ok || utf8.RuneCountInString(text) > 1000 {
				Raise("invalid_input", fmt.Sprintf("checks[%d].args must be a string array", index))
			}
			args = append(args, text)
		}
		checks = append(checks, RsiCommand{Command: command, Args: args})
	}
	return checks
}

func RsiChangeInputOf(value any) RsiChangeInput {
	body := rsiPlainObject(value)
	if body == nil {
		body = map[string]any{}
	}
	title := rsiAssertText(body["title"], "title", 200, true)
	problem := rsiAssertText(body["problem"], "problem", 4000, true)
	normalized := RsiChangeInput{Title: title, Problem: problem, Changes: []RsiFileChange{}}
	if raw, ok := body["evidence"]; ok && raw != nil {
		text := rsiAssertText(raw, "evidence", 4000, false)
		if text != "" {
			normalized.Evidence = &text
		}
	}
	if raw, ok := body["diagnosis"]; ok && raw != nil {
		text := rsiAssertText(raw, "diagnosis", 4000, false)
		if text != "" {
			normalized.Diagnosis = &text
		}
	}
	if raw, ok := body["impact"]; ok && raw != nil {
		text := rsiAssertText(raw, "impact", 4000, false)
		if text != "" {
			normalized.Impact = &text
		}
	}
	if raw, ok := body["risk"]; ok && raw != nil {
		text := rsiAssertText(raw, "risk", 4000, false)
		if text != "" {
			normalized.Risk = &text
		}
	}
	if raw, ok := body["changes"]; ok {
		if items, isArray := rsiAsArrayOf(raw); isArray {
			for index, item := range items {
				normalized.Changes = append(normalized.Changes, rsiNormalizeChange(item, index))
			}
		}
	}
	rawChecks, checksPresent := body["checks"]
	normalized.Checks = rsiNormalizeChecks(rawChecks, checksPresent)
	activate := true
	if raw, ok := body["activate"]; ok {
		if flag, isBool := raw.(bool); isBool && !flag {
			activate = false
		}
	}
	normalized.Activate = &activate
	if flag, ok := body["dryRun"].(bool); ok && flag {
		normalized.DryRun = true
		disabled := false
		normalized.Activate = &disabled
	}
	if flag, ok := body["force"].(bool); ok && flag {
		normalized.Force = true
	}
	return normalized
}

func RsiChangeMaterial(receipt map[string]any, reply string) string {
	files := []string{}
	if rows, ok := rsiAsArrayOf(receipt["files"]); ok {
		for _, item := range rows {
			if text, isText := item.(string); isText {
				files = append(files, text)
			}
		}
	}
	checks := []string{}
	if rows, ok := rsiAsArrayOf(receipt["validation"]); ok {
		for _, row := range rows {
			switch typed := row.(type) {
			case map[string]any:
				checks = append(checks, rsiText(typed["command"])+": "+rsiText(typed["status"]))
			case []any:
				checks = append(checks, ": ")
			}
		}
	}
	parts := []string{
		strings.TrimSpace(reply),
		"",
		"",
		"",
		rsiText(receipt["report"]),
		"",
	}
	if title := rsiText(receipt["title"]); title != "" {
		parts[1] = "RSI 变更：" + title
	}
	if len(files) > 0 {
		parts[2] = "文件：" + strings.Join(files, ", ")
	}
	if len(checks) > 0 {
		parts[3] = "验证：" + strings.Join(checks, "；")
	}
	if diff := rsiText(receipt["diff"]); diff != "" {
		runes := []rune(diff)
		if len(runes) > 6000 {
			diff = string(runes[:6000])
		}
		parts[5] = "diff：\n```diff\n" + diff + "\n```"
	}
	kept := []string{}
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n\n")
}

func DescribeActivation(input RsiActivationInput) RsiActivation {
	if !input.Activate {
		if input.CommittedNow {
			return RsiActivation{State: "saved", Note: "仅保存，未重载"}
		}
		return RsiActivation{State: "saved", Note: "未重载，且这次调用没有产生提交"}
	}
	if input.Commit == nil || (input.Live && !input.CommittedNow) {
		return RsiActivation{State: "checked_only", Note: "这次调用只跑了检查，没有产生提交：源码是否需要更新，请自己核对后再判断。"}
	}
	if input.Live {
		return RsiActivation{State: "active", Note: "这次提交已在运行中的版本里，无需重载"}
	}
	return RsiActivation{State: "pending_reload", Note: "已安排重载"}
}

func RsiDirtyMessage(root string, blocked []string) string {
	paths := strings.Join(blocked, " ")
	return "Uncommitted changes outside this RSI change, and the change could not be built in an isolated worktree: " +
		strings.Join(blocked, ", ") + ". " +
		"Checks run against the working tree, so they would verify changes that the commit does not contain. " +
		"If you edited these files by hand, revert them and pass the same edits as changes to apply_rsi_change: " +
		"RSI edits must be written by the tool, and a hand-committed tree cannot be attributed to a verified RSI commit. " +
		"To keep them as ordinary work instead, commit them first, for example `git -C " + root + " add -A -- " + paths + " && git -C " + root + " commit -m \"wip\"`, " +
		"or revert them with `git -C " + root + " restore --staged --worktree -- " + paths + "`. " +
		"Files left behind by an earlier failed RSI attempt on this branch are committed instead of reported."
}

func rsiReplacedContent(root string, change RsiFileChange, index int, path string, existing *string, owned bool) string {
	if existing == nil {
		Raise("not_found", "Cannot replace missing RSI file "+path)
	}
	content := *existing
	if change.FromPath != nil {
		content = rsiChangeContent(root, change, index)
		if refusal := rsiWriteShrinkRefusal(path, *existing, content); refusal != "" {
			Raise("rsi_edit_conflict", refusal)
		}
		return content
	}
	failures := []string{}
	for editIndex, edit := range change.Edits {
		matches := strings.Count(content, edit.OldText)
		if matches != 1 {
			failures = append(failures, rsiEditMismatch(editIndex, len(change.Edits), matches, edit.OldText))
			continue
		}
		content = strings.Replace(content, edit.OldText, edit.NewText, 1)
	}
	if len(failures) > 0 {
		hint := ""
		if owned {
			hint = "；该文件当前是上一轮未提交（检查失败保留）的内容：oldText 要按它现在的样子匹配，或改用 action \"write\" 直接给全文"
		}
		if len(failures) == 1 {
			Raise("rsi_edit_conflict", "RSI replacement in "+path+" must match exactly once, "+failures[0]+hint)
		}
		Raise("rsi_edit_conflict", "RSI replacement in "+path+" has "+itoa(len(failures))+" of "+
			itoa(len(change.Edits))+" edits that do not match exactly once, so nothing was written: "+
			strings.Join(failures, "; ")+hint)
	}
	return content
}
