package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed testdata/journey_driver.go.tmpl
var driverSource string

type step struct {
	Verb      string  `json:"verb"`
	Name      string  `json:"name,omitempty"`
	Role      string  `json:"role,omitempty"`
	Value     string  `json:"value,omitempty"`
	Text      string  `json:"text,omitempty"`
	Key       string  `json:"key,omitempty"`
	Path      string  `json:"path,omitempty"`
	TimeoutMs int     `json:"timeoutMs,omitempty"`
	ScrollY   float32 `json:"scrollY,omitempty"`
}

type apiCheck struct {
	Method       string         `json:"method"`
	Path         string         `json:"path"`
	Body         any            `json:"body,omitempty"`
	ExpectStatus int            `json:"expectStatus,omitempty"`
	Expect       map[string]any `json:"expect,omitempty"`
	ExpectExact  map[string]any `json:"expectExact,omitempty"`
	ID           string         `json:"id,omitempty"`
	Capture      string         `json:"capture,omitempty"`
}

type journey struct {
	ID          string      `json:"id"`
	Feature     string      `json:"feature"`
	Description string      `json:"description,omitempty"`
	Width       int         `json:"width,omitempty"`
	Height      int         `json:"height,omitempty"`
	Instance    string      `json:"instance,omitempty"`
	Surface     string      `json:"surface,omitempty"`
	Seed        *seedPrompt `json:"seed,omitempty"`
	Prepare     []apiCheck  `json:"prepare,omitempty"`
	Steps       []step      `json:"steps"`
	Checks      []apiCheck  `json:"checks,omitempty"`
}

// mode is the instance a journey needs. A journey that seeds a conversation
// needs an execute-capable daemon (view-only refuses dispatch); everything else
// runs on the default view instance so journeys stay cheap and read-only.
func (j journey) mode() string {
	if strings.EqualFold(strings.TrimSpace(j.Instance), "execute") || j.Seed != nil {
		return "execute"
	}
	return "view"
}

type stepOutcome struct {
	Index   int    `json:"index"`
	Verb    string `json:"verb"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

type journeyResult struct {
	OK       bool          `json:"ok"`
	Lane     string        `json:"lane,omitempty"`
	Error    string        `json:"error,omitempty"`
	Steps    []stepOutcome `json:"steps"`
	Texts    []string      `json:"texts,omitempty"`
	Frames   []string      `json:"frames,omitempty"`
	Access   []accessDump  `json:"access,omitempty"`
	Output   string        `json:"output,omitempty"`
	ExitCode int           `json:"exitCode,omitempty"`
}

type accessDump struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Value     string `json:"value,omitempty"`
	Focusable bool   `json:"focusable,omitempty"`
	Offscreen bool   `json:"offscreen,omitempty"`
}

func loadJourney(path string) (journey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return journey{}, err
	}
	var value journey
	if err := json.Unmarshal(raw, &value); err != nil {
		return journey{}, fmt.Errorf("%s: %w", path, err)
	}
	if value.ID == "" {
		value.ID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	if len(value.Steps) == 0 {
		return journey{}, fmt.Errorf("%s: a journey needs at least one step", path)
	}
	if value.Width <= 0 {
		value.Width = 1440
	}
	if value.Height <= 0 {
		value.Height = 900
	}
	return value, nil
}

func scenarioDir(p paths) string { return filepath.Join(p.Verification, "scenarios") }

func resolveJourney(p paths, reference string) (journey, error) {
	if reference == "" {
		return journey{}, fmt.Errorf("a journey is required")
	}
	candidates := []string{reference, filepath.Join(scenarioDir(p), reference)}
	if !strings.HasSuffix(reference, ".json") {
		candidates = append(candidates, filepath.Join(scenarioDir(p), reference+".json"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return loadJourney(candidate)
		}
	}
	return journey{}, fmt.Errorf("journey %q not found under verification/scenarios", reference)
}

func allJourneyPaths(p paths) ([]string, error) {
	entries, err := os.ReadDir(scenarioDir(p))
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		files = append(files, filepath.Join(scenarioDir(p), entry.Name()))
	}
	return files, nil
}

func runJourneyHeadless(p paths, meta runMeta, value journey, outDir string) journeyResult {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	work := filepath.Join(filepath.Dir(meta.StateDir), "overlay", value.ID)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	driverPath := filepath.Join(work, "driver_test.go")
	if err := os.WriteFile(driverPath, []byte(driverSource), 0o644); err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	specPath := filepath.Join(work, "journey.json")
	spec, err := json.Marshal(value)
	if err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	if err := os.WriteFile(specPath, spec, 0o644); err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	overlayPath := filepath.Join(work, "overlay.json")
	overlay := map[string]any{"Replace": map[string]string{
		filepath.Join(p.AppDir, "zz_verifygraph_driver_test.go"): driverPath,
	}}
	overlayRaw, _ := json.MarshalIndent(overlay, "", "  ")
	if err := os.WriteFile(overlayPath, overlayRaw, 0o644); err != nil {
		return journeyResult{OK: false, Error: err.Error(), ExitCode: 1}
	}
	resultPath := filepath.Join(outDir, "result.json")
	_ = os.Remove(resultPath)
	command := exec.Command("go", "test", "-overlay", overlayPath,
		"-run", "^TestVerifyGraphJourney$", "-count=1", "-v", ".")
	command.Dir = p.AppDir
	command.Env = append(os.Environ(),
		"VG_URL="+meta.Daemon.URL,
		"VG_TOKEN="+readToken(meta.StateDir),
		"VG_STATE_DIR="+meta.StateDir,
		"VG_JOURNEY="+specPath,
		"VG_OUT="+outDir,
	)
	output, runErr := command.CombinedOutput()
	result := journeyResult{Output: truncate(string(output), 6000)}
	if raw, err := os.ReadFile(resultPath); err == nil {
		var driver journeyResult
		if json.Unmarshal(raw, &driver) == nil {
			driver.Output = result.Output
			result = driver
		}
	}
	if runErr != nil {
		result.OK = false
		if result.Error == "" {
			result.Error = "the headless journey did not finish: " + runErr.Error()
		}
		if exit, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = exit.ExitCode()
		}
	}
	return result
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "\n…(truncated)"
}
