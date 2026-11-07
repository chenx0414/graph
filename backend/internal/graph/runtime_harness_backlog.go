package graph

import (
	"strings"

	"regexp"
)

const HARNESS_BACKLOG_ARTIFACT = "harness-backlog"

const HARNESS_SOURCE_BACKLOG = "backlog"

var (
	harnessBacklogID = regexp.MustCompile(`\*\*([A-Za-z]{2,4}-[0-9]+)\*\*`)
	harnessBacklogFixed = regexp.MustCompile("Fixed@\\s*`?([0-9a-f]{7,40})`?")
)

func harnessBacklogEntries(reader harnessExperienceReader, taskId string) []HarnessExperienceEntry {
	if reader == nil || taskId == "" {
		return []HarnessExperienceEntry{}
	}
	page := reader.List(ArtifactQuery{
		TaskId:    taskId,
		Namespace: HARNESS_EXPERIENCE_NAMESPACE,
		Prefix:    HARNESS_BACKLOG_ARTIFACT,
		Limit:     intPointer(10),
	})
	record := ArtifactRecord{}
	found := false
	for _, artifact := range page.Artifacts {
		if artifact.Name != HARNESS_BACKLOG_ARTIFACT {
			continue
		}
		if !found || artifact.Scope == "project" || (record.Scope != "project" && artifact.Version > record.Version) {
			record = artifact
			found = true
		}
	}
	if !found {
		return []HarnessExperienceEntry{}
	}
	body := reader.ReadVerifiedContent(taskId, record.ArtifactId, record.Version, HARNESS_EXPERIENCE_MAX_BYTES)
	if len(body) == 0 {
		return []HarnessExperienceEntry{}
	}
	return harnessParseBacklog(string(body))
}

func harnessParseBacklog(content string) []HarnessExperienceEntry {
	entries := []HarnessExperienceEntry{}
	section := ""
	item := []string{}
	flush := func() {
		if len(item) > 0 {
			entries = append(entries, harnessBacklogEntry(section, item))
		}
		item = nil
	}
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			flush()
			section = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(trimmed, "## ")))
			continue
		}
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			flush()
			item = []string{strings.TrimSpace(trimmed[2:])}
			continue
		}
		if len(item) > 0 && trimmed != "" {
			item = append(item, trimmed)
		}
	}
	flush()
	return entries
}

func harnessBacklogEntry(section string, lines []string) HarnessExperienceEntry {
	text := strings.TrimSpace(strings.Join(lines, " "))
	status := HARNESS_STATUS_OPEN
	switch {
	case strings.Contains(section, "fixed"):
		status = HARNESS_STATUS_FIXED
	case strings.Contains(section, "reject"):
		status = HARNESS_STATUS_REJECTED
	}
	ref := ""
	if match := harnessBacklogFixed.FindStringSubmatch(text); match != nil {
		status = HARNESS_STATUS_FIXED
		ref = match[1]
	}
	cue := strings.TrimSpace(lines[0])
	if match := harnessBacklogID.FindStringSubmatch(cue); match != nil {
		cue = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(cue, match[0]), "-—"))
	}
	cue = strings.TrimSpace(harnessBacklogFixed.ReplaceAllString(cue, ""))
	return HarnessExperienceEntry{
		Status: status,
		Cue:    harnessBoundText(cue, 240),
		Note:   harnessBoundText(text, 4000),
		Ref:    ref,
		Source: HARNESS_SOURCE_BACKLOG,
	}
}
