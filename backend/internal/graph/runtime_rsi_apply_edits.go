package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Writing one change: the bytes a `changes[]` entry names, and the refusals that
// keep an edit honest. Kept beside the apply loop rather than inside it, so the
// loop stays readable and no file outgrows the budget a reader can hold.

// rsiChangeContent is the new text of one change: given inline, or read from a
// file the Agent already wrote in the checkout.
//
// The second form exists because the most expensive call this tool served was a
// file pasted back in: the Agent writes a keeper test with its own tools, runs
// it, and then had to repeat every line inside `changes[]`. Naming the file
// commits exactly the bytes that were verified.
func rsiChangeContent(root string, change RsiFileChange, index int) string {
	if change.FromPath == nil {
		if change.Content == nil {
			Raise("invalid_input", "changes["+itoa(index)+"] has no content: give content or fromPath")
		}
		return *change.Content
	}
	source, ok := rsiInside(root, *change.FromPath)
	if !ok {
		Raise("invalid_input", "changes["+itoa(index)+"].fromPath must stay inside the Graph source root")
	}
	raw, err := os.ReadFile(filepath.Join(root, source))
	if err != nil {
		if os.IsNotExist(err) {
			Raise("not_found", "changes["+itoa(index)+"].fromPath "+source+
				" does not exist in the checkout: write the file first, then name it here instead of pasting its text")
		}
		Raise("rsi_edit_conflict", "changes["+itoa(index)+"].fromPath "+source+" could not be read: "+err.Error())
	}
	return string(raw)
}

// rsiEditMismatch names one anchor that does not match exactly once.
func rsiEditMismatch(index, total, matches int, oldText string) string {
	head := strings.TrimSpace(strings.Split(oldText, "\n")[0])
	runes := []rune(head)
	if len(runes) > 90 {
		head = string(runes[:90])
	}
	return "found " + itoa(matches) + " (edit " + itoa(index+1) + " of " + itoa(total) + ", first line: " + head + ")"
}

// rsiWriteShrinkRefusal refuses a write that would replace a large file with a
// stub.
//
// The rule is deliberately blunt: a file of rsiWriteShrinkLines lines or more
// may not be written down to less than a tenth of itself in one write. Anything
// smaller is ordinary editing; anything larger is either a rewrite that deserves
// to be spelled out as edits, or the accident this guard exists for.
const rsiWriteShrinkLines = 200

func rsiWriteShrinkRefusal(path, before, after string) string {
	oldLines := strings.Count(before, "\n") + 1
	if oldLines < rsiWriteShrinkLines {
		return ""
	}
	newLines := strings.Count(after, "\n") + 1
	if newLines*10 >= oldLines {
		return ""
	}
	return fmt.Sprintf(
		"RSI write to %s would replace %d lines with %d: a whole-file write carries no evidence of what it removed. "+
			"Use replace with edits that name what goes, or split the deletion into several such edits.", path, oldLines, newLines)
}
