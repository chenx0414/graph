package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// entryLabelPattern picks the 「」 spans out of a feature's entry point. That
// punctuation is the repository's way of writing "this exact label is on
// screen": 侧栏「洞察」 names the rail button, not the concept of insights.
var entryLabelPattern = regexp.MustCompile(`「([^」]+)」`)

// quotedEntryLabels lists the on-screen labels one feature's entry point claims.
func quotedEntryLabels(entry string) []string {
	labels := []string{}
	for _, match := range entryLabelPattern.FindAllStringSubmatch(entry, -1) {
		label := strings.TrimSpace(match[1])
		if label == "" {
			continue
		}
		labels = append(labels, label)
	}
	return labels
}

// appSourceText is every non-test Go file under app/, concatenated. The entry
// point names a user-visible label, and labels live in that package: a rail
// item, a button caption, a panel title.
func appSourceText(root string) (string, error) {
	directory := filepath.Join(root, "app")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", directory, err)
	}
	builder := &strings.Builder{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		payload, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			return "", fmt.Errorf("read %s: %w", entry.Name(), readErr)
		}
		builder.Write(payload)
		builder.WriteString("\n")
	}
	return builder.String(), nil
}

// missingEntryLabels answers one question: which feature claims a control the
// window no longer has? F-09 kept saying 侧栏「洞察」 for two weeks after the page
// was deleted, and the map stayed green because it only compared routes.
func missingEntryLabels(root string) []string {
	index, err := readFeatureIndex(root)
	if err != nil {
		return []string{err.Error()}
	}
	sources, err := appSourceText(root)
	if err != nil {
		return []string{err.Error()}
	}
	missing := []string{}
	for _, feature := range index.Features {
		for _, label := range quotedEntryLabels(feature.Entry) {
			if strings.Contains(sources, label) {
				continue
			}
			missing = append(missing, fmt.Sprintf("%s %s: entry quotes 「%s」, which no app/ source contains; the page is gone or never existed", feature.ID, feature.Title, label))
		}
	}
	return missing
}
