package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)


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

func rsiEditMismatch(index, total, matches int, oldText string) string {
	head := strings.TrimSpace(strings.Split(oldText, "\n")[0])
	runes := []rune(head)
	if len(runes) > 90 {
		head = string(runes[:90])
	}
	return "found " + itoa(matches) + " (edit " + itoa(index+1) + " of " + itoa(total) + ", first line: " + head + ")"
}

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
