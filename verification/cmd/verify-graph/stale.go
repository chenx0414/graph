package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// pageMapPath is the declared page → source file mapping. The audit cannot
// infer it: control names are ordinary words (「刷新」, 「断开」) that appear in
// a dozen files, so guessing marks unrelated pages stale. A wrong guess here
// would make the whole check untrustworthy, which is worse than not having it.
const pageMapPath = "controls/pages.json"

type pageSources struct {
	Pages map[string][]string `json:"pages"`
}

func readPageSources(verificationRoot string) (pageSources, error) {
	path := filepath.Join(verificationRoot, pageMapPath)
	raw, err := os.ReadFile(path)
	if err != nil {
		return pageSources{}, fmt.Errorf("read %s: %w", path, err)
	}
	var sources pageSources
	if err := json.Unmarshal(raw, &sources); err != nil {
		return pageSources{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return sources, nil
}

// witnessPages lists the pages a ledger makes claims about.
func witnessPages(ledgerPath string) ([]string, error) {
	raw, err := os.ReadFile(ledgerPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", ledgerPath, err)
	}
	var ledger struct {
		Witnesses []struct {
			Page string `json:"page"`
		} `json:"witnesses"`
	}
	if err := json.Unmarshal(raw, &ledger); err != nil {
		return nil, fmt.Errorf("parse %s: %w", ledgerPath, err)
	}
	seen := map[string]bool{}
	pages := []string{}
	for _, witness := range ledger.Witnesses {
		page := strings.TrimSpace(witness.Page)
		if page == "" || seen[page] {
			continue
		}
		seen[page] = true
		pages = append(pages, page)
	}
	sort.Strings(pages)
	return pages, nil
}

// undeclaredPages names the pages the ledger claims but the map does not place.
// They are not judged: an honest "cannot tell" beats a made-up answer.
func undeclaredPages(verificationRoot, ledgerPath string) []string {
	sources, err := readPageSources(verificationRoot)
	if err != nil {
		return []string{err.Error()}
	}
	pages, err := witnessPages(ledgerPath)
	if err != nil {
		return []string{err.Error()}
	}
	undeclared := []string{}
	for _, page := range pages {
		if len(sources.Pages[page]) > 0 {
			continue
		}
		undeclared = append(undeclared, fmt.Sprintf("page %q has witnesses but no entry in %s; declare its sources so its evidence can be judged", page, pageMapPath))
	}
	return undeclared
}

// staleWitnessPages answers one question: which page's evidence is older than
// the page itself?
//
// A witness claims a control was really driven. The claim keeps its meaning
// only while the page stays put: after the page is rebuilt the same button name
// passes every other check while the recorded run describes code that no longer
// exists. This is the shape that hid the deleted insights page — `covered`
// rested on a run recorded two days before the page was deleted.
//
// The comparison uses the run's own recorded time (`endedAt` in summary.json),
// never a file's mtime: a git checkout rewrites mtimes to "now", which would
// make every witness look fresh on one machine and stale on another.
func staleWitnessPages(verificationRoot, ledgerPath, appDir string) []string {
	sources, err := readPageSources(verificationRoot)
	if err != nil {
		return []string{err.Error()}
	}
	pages, err := witnessPages(ledgerPath)
	if err != nil {
		return []string{err.Error()}
	}
	recorded := recordedRunTimes(filepath.Join(verificationRoot, "evidence"), ledgerPath, scenarioDirFromVerification(verificationRoot))
	stale := []string{}
	for _, page := range pages {
		files := sources.Pages[page]
		if len(files) == 0 {
			continue
		}
		changedAt, changedFile, ok := newestSourceChange(appDir, files)
		if !ok {
			continue
		}
		runAt, known := recorded[page]
		if !known || runAt.IsZero() {
			continue
		}
		if runAt.Before(changedAt) {
			stale = append(stale, fmt.Sprintf("page %q: its evidence was recorded %s, but app/%s changed %s later; rerun the journey that covers it",
				page, runAt.UTC().Format(time.RFC3339), changedFile, changedAt.Sub(runAt).Round(time.Second)))
		}
	}
	return stale
}

// recordedRunTimes is the newest recorded run per page.
//
// Evidence is laid out per feature (evidence/<run>/F-02/summary.json), while a
// witness names a page: 侧栏 buttons live on page `rail`, not F-02. So the page
// is resolved through its witnesses' journeys to the feature each journey
// declares, and only a page that resolves to no recorded run is left unjudged.
func recordedRunTimes(evidenceRoot, ledgerPath, scenarioDir string) map[string]time.Time {
	times := map[string]time.Time{}
	raw, err := os.ReadFile(ledgerPath)
	if err != nil {
		return times
	}
	var ledger struct {
		Witnesses []struct {
			Page    string `json:"page"`
			Journey string `json:"journey"`
		} `json:"witnesses"`
	}
	if json.Unmarshal(raw, &ledger) != nil {
		return times
	}
	featureOf := map[string]string{}
	entries, err := os.ReadDir(evidenceRoot)
	if err != nil {
		return times
	}
	for _, witness := range ledger.Witnesses {
		page := strings.TrimSpace(witness.Page)
		if page == "" {
			continue
		}
		feature := featureOf[witness.Journey]
		if feature == "" {
			feature = journeyFeature(scenarioDir, witness.Journey)
			featureOf[witness.Journey] = feature
		}
		names := []string{page}
		if feature != "" {
			names = append(names, feature)
		}
		for _, run := range entries {
			if !run.IsDir() {
				continue
			}
			for _, name := range names {
				at, ok := summaryEndedAt(filepath.Join(evidenceRoot, run.Name(), name, "summary.json"))
				if !ok {
					continue
				}
				if at.After(times[page]) {
					times[page] = at
				}
			}
		}
	}
	return times
}

// journeyFeature reads the feature a journey declares, so a page can be matched
// to the evidence directory a run wrote for that feature.
func journeyFeature(scenarioDir, journey string) string {
	name := strings.TrimSuffix(filepath.Base(strings.TrimSpace(journey)), ".json")
	if name == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(scenarioDir, name+".json"))
	if err != nil {
		return ""
	}
	var scenario struct {
		Feature string `json:"feature"`
		ID      string `json:"id"`
	}
	if json.Unmarshal(raw, &scenario) != nil {
		return ""
	}
	return strings.TrimSpace(scenario.Feature)
}

func scenarioDirFromVerification(verificationRoot string) string {
	return filepath.Join(verificationRoot, "scenarios")
}

func summaryEndedAt(path string) (time.Time, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, false
	}
	var summary struct {
		EndedAt   string `json:"endedAt"`
		StartedAt string `json:"startedAt"`
	}
	if json.Unmarshal(raw, &summary) != nil {
		return time.Time{}, false
	}
	for _, value := range []string{summary.EndedAt, summary.StartedAt} {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if at, err := time.Parse(time.RFC3339, value); err == nil {
			return at, true
		}
	}
	return time.Time{}, false
}

func newestSourceChange(appDir string, files []string) (time.Time, string, bool) {
	newest := time.Time{}
	name := ""
	for _, candidate := range files {
		info, err := os.Stat(filepath.Join(appDir, candidate))
		if err != nil {
			continue
		}
		if name == "" || info.ModTime().After(newest) {
			newest, name = info.ModTime(), candidate
		}
	}
	return newest, name, name != ""
}

// checkDeclaredSources proves the map is real: every declared file must exist,
// so a rename cannot leave the audit judging a page against a file that is gone.
func checkDeclaredSources(verificationRoot, appDir string) []string {
	sources, err := readPageSources(verificationRoot)
	if err != nil {
		return []string{err.Error()}
	}
	problems := []string{}
	for page, files := range sources.Pages {
		for _, name := range files {
			if _, err := os.Stat(filepath.Join(appDir, name)); err != nil {
				problems = append(problems, fmt.Sprintf("page %q declares app/%s, which does not exist", page, name))
			}
		}
	}
	sort.Strings(problems)
	return problems
}
