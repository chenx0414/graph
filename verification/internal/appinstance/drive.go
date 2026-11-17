package appinstance

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
)

type StepResult struct {
	ID       string   `json:"id"`
	Action   string   `json:"action"`
	OK       bool     `json:"ok"`
	Expected string   `json:"expected,omitempty"`
	Actual   string   `json:"actual,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
	Hint     string   `json:"hint,omitempty"`
}

func (i *Instance) ClickAndProve(window Window, label, expectNewText string, timeout time.Duration) (StepResult, []Artifact, error) {
	result := StepResult{ID: "click:" + label, Action: "click", Expected: "the window changes after clicking " + label}
	before, err := i.DesktopClient().Snapshot(window.ID)
	if err != nil {
		result.Actual = "cannot snapshot the window: " + err.Error()
		result.Hint = "run: verify-graph doctor (agent-desktop must answer snapshot for this window)"
		return result, nil, err
	}
	beforeNames := strings.Join(before.Names(), "|")
	if _, err := i.DesktopClient().Click(window, label); err != nil {
		result.Actual = "cannot click: " + err.Error()
		result.Hint = fmt.Sprintf("run: verify-graph ui find --name %q --exact", label)
		return result, nil, err
	}
	if timeout <= 0 {
		timeout = 25 * time.Second
	}
	deadline := time.Now().Add(timeout)
	var afterNames string
	var snapshot Snapshot
	for time.Now().Before(deadline) {
		time.Sleep(400 * time.Millisecond)
		snapshot, err = i.DesktopClient().Snapshot(window.ID)
		if err != nil {
			continue
		}
		afterNames = strings.Join(snapshot.Names(), "|")
		if expectNewText != "" {
			if snapshot.Contains(expectNewText) {
				result.OK = true
				break
			}
			continue
		}
		if afterNames != beforeNames {
			result.OK = true
			break
		}
	}
	artifacts := []Artifact{}
	beforeJSON, _ := json.MarshalIndent(before, "", "  ")
	if artifact, err := i.WriteEvidence("ax-before-"+slug(label)+".json", beforeJSON); err == nil {
		artifacts = append(artifacts, artifact)
		result.Evidence = append(result.Evidence, artifact.Path)
	}
	afterJSON, _ := json.MarshalIndent(snapshot, "", "  ")
	if artifact, err := i.WriteEvidence("ax-after-"+slug(label)+".json", afterJSON); err == nil {
		artifacts = append(artifacts, artifact)
		result.Evidence = append(result.Evidence, artifact.Path)
	}
	png := i.Evidence("window-" + slug(label) + ".png")
	if err := i.DesktopClient().ScreenshotRect(window, png); err == nil {
		artifacts = append(artifacts, artifact(png))
		result.Evidence = append(result.Evidence, png)
	}
	if result.OK {
		result.Actual = truncate("clicking "+label+" produced: "+afterNames, 600)
	} else {
		result.Actual = truncate("the window never changed after clicking "+label+"; still shows: "+afterNames, 600)
		result.Hint = fmt.Sprintf("run: verify-graph ui snapshot --window %s, then check whether %q is in the rail", window.ID, label)
	}
	return result, artifacts, nil
}

func slug(value string) string {
	mapped := []rune{}
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) {
			mapped = append(mapped, char)
			continue
		}
		mapped = append(mapped, '-')
	}
	slug := strings.Trim(string(mapped), "-")
	if slug == "" {
		return "target"
	}
	return slug
}
