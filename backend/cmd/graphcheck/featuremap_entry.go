package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var entryLabelPattern = regexp.MustCompile(`「([^」]+)」`)

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
