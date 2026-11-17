package evidence

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	KindAX         = "ax"
	KindScreenshot = "screenshot"
	KindAPI        = "api"
	KindState      = "state"
	KindLog        = "log"
	KindText       = "text"
)

type Artifact struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Note   string `json:"note,omitempty"`
}

type Assertion struct {
	ID       string   `json:"id"`
	OK       bool     `json:"ok"`
	Expected string   `json:"expected,omitempty"`
	Actual   string   `json:"actual,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
}

type Skip struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type AssertionFile struct {
	Scenario   string      `json:"scenario"`
	Run        string      `json:"run"`
	Assertions []Assertion `json:"assertions"`
}

type Summary struct {
	Scenario  string    `json:"scenario"`
	Run       string    `json:"run"`
	OK        bool      `json:"ok"`
	Passed    int       `json:"passed"`
	Failed    int       `json:"failed"`
	Skipped   []Skip    `json:"skipped,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt"`
	Manifest  string    `json:"manifest"`
}

type FinishOptions struct {
	Scenario  string
	ForceFail bool
	Skipped   []Skip
}

type FileHash struct {
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type ManifestFile struct {
	GeneratedAt time.Time           `json:"generatedAt"`
	Files       map[string]FileHash `json:"files"`
}

type Recorder struct {
	root       string
	run        string
	scenario   string
	dir        string
	artifacts  []Artifact
	assertions []Assertion
	started    time.Time
}

func NewRecorder(root, run, scenario string) (*Recorder, error) {
	if strings.TrimSpace(run) == "" || strings.TrimSpace(scenario) == "" {
		return nil, fmt.Errorf("evidence: run and scenario are required")
	}
	dir := filepath.Join(root, run, scenario)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Recorder{root: root, run: run, scenario: scenario, dir: dir, started: time.Now().UTC()}, nil
}

func (r *Recorder) Dir() string {
	return r.dir
}

func (r *Recorder) Run() string {
	return r.run
}

func (r *Recorder) Scenario() string {
	return r.scenario
}

func (r *Recorder) Artifacts() []Artifact {
	return append([]Artifact(nil), r.artifacts...)
}

func (r *Recorder) Assertions() []Assertion {
	return append([]Assertion(nil), r.assertions...)
}

func (r *Recorder) Assert(assertion Assertion) {
	r.assertions = append(r.assertions, assertion)
}

func (r *Recorder) SaveJSON(name string, value any) (Artifact, error) {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return Artifact{}, err
	}
	return r.save(name, KindState, payload)
}

func (r *Recorder) SaveText(name, text string) (Artifact, error) {
	return r.save(name, KindText, []byte(text))
}

func (r *Recorder) SaveBytes(name, kind string, payload []byte) (Artifact, error) {
	return r.save(name, kind, payload)
}

func (r *Recorder) SaveFile(kind, source string) (Artifact, error) {
	payload, err := os.ReadFile(source)
	if err != nil {
		return Artifact{}, err
	}
	if kind == "" {
		kind = KindText
	}
	name := filepath.Join("files", filepath.Base(source))
	return r.save(name, kind, payload)
}

func (r *Recorder) save(name, kind string, payload []byte) (Artifact, error) {
	target, err := r.resolve(name)
	if err != nil {
		return Artifact{}, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return Artifact{}, err
	}
	if err := os.WriteFile(target, payload, 0o644); err != nil {
		return Artifact{}, err
	}
	relative, err := filepath.Rel(r.dir, target)
	if err != nil {
		return Artifact{}, err
	}
	artifact := Artifact{
		Kind:   kind,
		Path:   filepath.ToSlash(relative),
		SHA256: HashBytes(payload),
		Bytes:  int64(len(payload)),
	}
	r.artifacts = append(r.artifacts, artifact)
	return artifact, nil
}

func (r *Recorder) resolve(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", fmt.Errorf("evidence: empty artifact name")
	}
	if strings.ContainsRune(name, 0) || filepath.IsAbs(name) {
		return "", fmt.Errorf("evidence: artifact name must be relative: %q", name)
	}
	cleaned := filepath.Clean(name)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return "", fmt.Errorf("evidence: artifact name escapes the run directory: %q", name)
	}
	target := filepath.Join(r.dir, cleaned)
	relative, err := filepath.Rel(r.dir, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") {
		return "", fmt.Errorf("evidence: artifact name escapes the run directory: %q", name)
	}
	return target, nil
}

func (r *Recorder) Finish(options FinishOptions) (Summary, error) {
	scenario := r.scenario
	if options.Scenario != "" {
		scenario = options.Scenario
	}
	file := AssertionFile{Scenario: scenario, Run: r.run, Assertions: r.assertions}
	if _, err := r.SaveJSON("assertions.json", file); err != nil {
		return Summary{}, err
	}
	passed, failed := 0, 0
	for _, assertion := range r.assertions {
		if assertion.OK {
			passed++
		} else {
			failed++
		}
	}
	summary := Summary{
		Scenario:  scenario,
		Run:       r.run,
		OK:        failed == 0 && !options.ForceFail,
		Passed:    passed,
		Failed:    failed,
		Skipped:   options.Skipped,
		StartedAt: r.started,
		EndedAt:   time.Now().UTC(),
		Manifest:  "manifest.json",
	}
	if _, err := r.SaveJSON("summary.json", summary); err != nil {
		return Summary{}, err
	}
	manifest, err := Manifest(r.dir)
	if err != nil {
		return Summary{}, err
	}
	if _, err := r.SaveJSON("manifest.json", manifest); err != nil {
		return Summary{}, err
	}
	return summary, nil
}

func HashBytes(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func HashFile(path string) (string, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return HashBytes(payload), nil
}

func Manifest(dir string) (ManifestFile, error) {
	manifest := ManifestFile{GeneratedAt: time.Now().UTC(), Files: map[string]FileHash{}}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("evidence: %s is not a regular file", path)
		}
		relative, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "manifest.json" {
			return nil
		}
		digest, err := HashFile(path)
		if err != nil {
			return err
		}
		manifest.Files[relative] = FileHash{SHA256: digest, Bytes: info.Size()}
		return nil
	})
	if err != nil {
		return ManifestFile{}, err
	}
	return manifest, nil
}

func Verify(dir string) ([]string, error) {
	payload, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var manifest ManifestFile
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return nil, fmt.Errorf("evidence: manifest.json is not valid JSON: %w", err)
	}
	problems := []string{}
	for name, want := range manifest.Files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		info, err := os.Stat(path)
		if err != nil {
			problems = append(problems, name+": missing")
			continue
		}
		got, err := HashFile(path)
		if err != nil {
			problems = append(problems, name+": "+err.Error())
			continue
		}
		if got != want.SHA256 || info.Size() != want.Bytes {
			problems = append(problems, fmt.Sprintf("%s: sha256 %s bytes %d, manifest says %s bytes %d", name, got, info.Size(), want.SHA256, want.Bytes))
		}
	}
	present, err := listFiles(dir)
	if err != nil {
		return problems, err
	}
	for _, name := range present {
		if name == "manifest.json" {
			continue
		}
		if _, known := manifest.Files[name]; !known {
			problems = append(problems, name+": unlisted")
		}
	}
	sort.Strings(problems)
	return problems, nil
}

func Pack(dir, out string) (Artifact, error) {
	files, err := listFiles(dir)
	if err != nil {
		return Artifact{}, err
	}
	if len(files) == 0 {
		return Artifact{}, fmt.Errorf("evidence: %s has no files to pack", dir)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return Artifact{}, err
	}
	file, err := os.Create(out)
	if err != nil {
		return Artifact{}, err
	}
	writer := gzip.NewWriter(file)
	archive := tar.NewWriter(writer)
	failure := error(nil)
	for _, name := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		payload, err := os.ReadFile(path)
		if err != nil {
			failure = err
			break
		}
		header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(payload)), ModTime: time.Unix(0, 0).UTC()}
		if err := archive.WriteHeader(header); err != nil {
			failure = err
			break
		}
		if _, err := archive.Write(payload); err != nil {
			failure = err
			break
		}
	}
	if err := archive.Close(); err != nil && failure == nil {
		failure = err
	}
	if err := writer.Close(); err != nil && failure == nil {
		failure = err
	}
	if err := file.Close(); err != nil && failure == nil {
		failure = err
	}
	if failure != nil {
		_ = os.Remove(out)
		return Artifact{}, failure
	}
	payload, err := os.ReadFile(out)
	if err != nil {
		return Artifact{}, err
	}
	return Artifact{Kind: "archive", Path: out, SHA256: HashBytes(payload), Bytes: int64(len(payload))}, nil
}

func listFiles(dir string) ([]string, error) {
	files := []string{}
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(relative))
		return nil
	})
	sort.Strings(files)
	return files, err
}

func RedactPaths(value string, prefixes ...string) string {
	redacted := value
	for _, prefix := range prefixes {
		if strings.TrimSpace(prefix) == "" {
			continue
		}
		trimmed := strings.TrimSuffix(prefix, "/")
		if trimmed == "" {
			continue
		}
		redacted = strings.ReplaceAll(redacted, trimmed, "~")
	}
	return redacted
}

func RedactSecret(value string) string {
	return "sha256:" + HashBytes([]byte(value))[:12]
}

type OutcomeFile struct {
	Scenario   string
	Run        string
	StartedAt  time.Time
	Assertions []Assertion
	Skipped    []Skip
	ForceFail  bool
}

func Summarize(dir string, outcome OutcomeFile) (Summary, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Summary{}, err
	}
	file := AssertionFile{Scenario: outcome.Scenario, Run: outcome.Run, Assertions: outcome.Assertions}
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return Summary{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, "assertions.json"), payload, 0o644); err != nil {
		return Summary{}, err
	}
	passed, failed := 0, 0
	for _, assertion := range outcome.Assertions {
		if assertion.OK {
			passed++
		} else {
			failed++
		}
	}
	started := outcome.StartedAt
	if started.IsZero() {
		started = time.Now().UTC()
	}
	summary := Summary{
		Scenario:  outcome.Scenario,
		Run:       outcome.Run,
		OK:        failed == 0 && !outcome.ForceFail,
		Passed:    passed,
		Failed:    failed,
		Skipped:   outcome.Skipped,
		StartedAt: started,
		EndedAt:   time.Now().UTC(),
		Manifest:  "manifest.json",
	}
	payload, err = json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return Summary{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, "summary.json"), payload, 0o644); err != nil {
		return Summary{}, err
	}
	manifest, err := Manifest(dir)
	if err != nil {
		return Summary{}, err
	}
	payload, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return Summary{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), payload, 0o644); err != nil {
		return Summary{}, err
	}
	return summary, nil
}
