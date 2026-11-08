// graph:table-writes-exempt: no table is written by this test
package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const asyncFullKnownRedOutput = "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/desktop-crash-recovery.test.ts\x1b[2m > \x1b[22ma killed app restarts on the same conversation with a real crash reason while its daemon and lanes keep working\n" +
	"\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/desktop-shell.test.ts\x1b[2m > \x1b[22mOpenRouter browser authorization persists through the real desktop keychain, calls a model after restart and disconnects\n" +
	"\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/provider-independent-reviews.test.ts\x1b[2m > \x1b[22mthe review node runs on an independent provider, the concluded ChatGPT platform is reported instead of called, and a broken transport falls back to Grok\n" +
	"      \x1b[33m×\x1b[39m a killed app restarts on the same conversation with a real crash reason while its daemon and lanes keep working \x1b[2m—\x1b[22m Error: timed out after 120000ms waiting for the master to create the graph\n" +
	"      \x1b[33m×\x1b[39m OpenRouter browser authorization persists through the real desktop keychain, calls a model after restart and disconnects \x1b[2m—\x1b[22m Error: expected 0 to be greater than 0\n" +
	"      \x1b[33m×\x1b[39m the review node runs on an independent provider, the concluded ChatGPT platform is reported instead of called, and a broken transport falls back to Grok \x1b[2m—\x1b[22m Error: the Grok CLI login expired at 2026-11-05T13:07:20.000000Z and its refresh answered 400\n" +
	"Test Files  3 failed | 249 passed | 1 skipped (253)\n"

func knownReds() []EnvKnownRed {
	return []EnvKnownRed{
		{File: "tests/e2e/desktop-crash-recovery.test.ts", Pattern: "waiting for the master to create the graph", Why: "本机"},
		{File: "tests/e2e/desktop-shell.test.ts", Pattern: "expected 0 to be greater than 0", Why: "钥匙串"},
		{File: "tests/e2e/provider-independent-reviews.test.ts", Pattern: "the Grok CLI login expired", Why: "凭据"},
	}
}

func TestAsyncFullFullRunOfKnownEnvironmentRedsIsNotCalledARegression(t *testing.T) {
	failures := AsyncFullFailures(asyncFullKnownRedOutput)
	if len(failures) != 3 {
		t.Fatalf("parsed %d failures instead of 3: %+v", len(failures), failures)
	}
	for _, failure := range failures {
		if failure.File == "" || failure.Test == "" || failure.Message == "" {
			t.Fatalf("a failure was parsed without file, test and message: %+v", failure)
		}
		if strings.Contains(failure.Message, "\x1b") {
			t.Fatalf("the escape codes were not stripped from %q", failure.Message)
		}
	}
	verdict := ClassifyAsyncFull(asyncFullKnownRedOutput, knownReds())
	if !verdict.Environment {
		t.Fatalf("three known environment reds were called a regression: %+v", verdict)
	}
	if len(verdict.Unmatched) != 0 {
		t.Fatalf("a known environment red was unmatched: %v", verdict.Unmatched)
	}
}

func TestAsyncFullOneNewFailingFileStaysARegression(t *testing.T) {
	output := asyncFullKnownRedOutput +
		"\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/orchestration-browser.test.ts\x1b[2m > \x1b[22mthe browser returns to the same global and project supervisors\n" +
		"      \x1b[33m×\x1b[39m the browser returns to the same global and project supervisors \x1b[2m—\x1b[22m Error: expected 1 to be 2\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if verdict.Environment {
		t.Fatalf("a brand new failing file was excused as an environment red: %+v", verdict)
	}
	if len(verdict.Unmatched) != 1 || !strings.Contains(verdict.Unmatched[0], "orchestration-browser.test.ts") {
		t.Fatalf("the new failure was not reported as the unmatched one: %v", verdict.Unmatched)
	}
}

func TestAsyncFullKnownRedFileWithANewErrorMessageStaysARegression(t *testing.T) {
	output := "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/desktop-shell.test.ts\x1b[2m > \x1b[22mOpenRouter browser authorization persists through the real desktop keychain\n" +
		"      \x1b[33m×\x1b[39m OpenRouter browser authorization persists through the real desktop keychain \x1b[2m—\x1b[22m Error: expected 'granted' to be 'denied'\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if verdict.Environment {
		t.Fatalf("a different error in a known red file was excused: %+v", verdict)
	}
	if len(verdict.Unmatched) != 1 || !strings.Contains(verdict.Unmatched[0], "desktop-shell.test.ts") {
		t.Fatalf("the changed message was not reported: %v", verdict.Unmatched)
	}
}

func TestAsyncFullQuarantineTimingLineIsStillMatched(t *testing.T) {
	output := "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/desktop-crash-recovery.test.ts\x1b[2m > \x1b[22ma killed app restarts on the same conversation\n" +
		"      \x1b[33m×\x1b[39m \x1b[2m[timing]\x1b[22m a killed app restarts on the same conversation \x1b[2m—\x1b[22m Error: timed out after 120000ms waiting for the master to create the graph\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if !verdict.Environment {
		t.Fatalf("the quarantined timing repeat was not matched to its known red: %+v", verdict)
	}
}

func TestAsyncFullShippingKnownRedListCoversEveryRedWeShipWith(t *testing.T) {
	path := filepath.Join("..", "..", "..", "tests", "env-known-reds.json")
	reds, err := LoadEnvKnownReds(path)
	if err != nil {
		t.Fatalf("the shipped known-red list does not load: %v", err)
	}
	if len(reds) == 0 {
		t.Fatalf("the shipped known-red list is empty")
	}
	verdict := ClassifyAsyncFull(asyncFullKnownRedOutput, reds)
	if !verdict.Environment || len(verdict.Unmatched) != 0 {
		t.Fatalf("the shipped list does not cover the three reds it is meant to: %+v", verdict)
	}
	for _, red := range reds {
		if !strings.HasPrefix(red.File, "tests/") || red.Pattern == "" || red.Why == "" {
			t.Fatalf("a known red entry lacks a test path, a pattern or a reason: %+v", red)
		}
	}
}

func TestLoadEnvKnownRedsRejectsAnUnreadableFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "reds.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := LoadEnvKnownReds(path); err == nil {
		t.Fatalf("a malformed known-red list was accepted")
	}
	if reds, err := LoadEnvKnownReds(filepath.Join(dir, "missing.json")); err != nil || len(reds) != 0 {
		t.Fatalf("a missing list must mean no known reds, got %v %v", reds, err)
	}
}

func TestAsyncFullRunnerListAttributesAMessageThatHasNoFailHeader(t *testing.T) {
	output := "check:tests: 4 file(s) failed twice, so the gate stops here:\n" +
		"  - tests/e2e/desktop-crash-recovery.test.ts\n" +
		"  - tests/e2e/desktop-shell.test.ts\n" +
		"  - tests/e2e/provider-independent-reviews.test.ts\n" +
		"  - tests/e2e/tool-result-spill.test.ts\n" +
		"      × [timing] a killed app restarts on the same conversation with a real crash reason while its daemon and lanes keep working — Error: timed out after 120000ms waiting for the master to create the graph at waitFor (/tmp/graph-async-full-1/tests/e2e/desktop-crash-recovery.fixture.ts:73:9)\n" +
		" ❯ tests/e2e/tool-result-spill.test.ts:70:21\n" +
		"     68|     const spilled = await readFile(handle!, 'utf8');\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if verdict.Environment {
		t.Fatalf("a real failure in the same run was excused because the known reds were in it: %+v", verdict)
	}
	joined := strings.Join(verdict.Unmatched, " | ")
	if !strings.Contains(joined, "tool-result-spill.test.ts") {
		t.Fatalf("the unrelated failure was not named: %v", verdict.Unmatched)
	}
	if strings.Contains(joined, "desktop-crash-recovery") {
		t.Fatalf("the known red was reported as unmatched because its message arrived without a FAIL header: %v", verdict.Unmatched)
	}
}

func TestAsyncFullRunnerListOnlyOfKnownFilesIsAnEnvironmentRed(t *testing.T) {
	output := "check:tests: 3 file(s) failed twice, so the gate stops here:\n" +
		"  - tests/e2e/desktop-crash-recovery.test.ts\n" +
		"  - tests/e2e/desktop-shell.test.ts\n" +
		"  - tests/e2e/provider-independent-reviews.test.ts\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if !verdict.Environment {
		t.Fatalf("a run that only failed the three known reds was called a regression: %+v", verdict)
	}
}

func TestAsyncFullFlakyFileThatPassedOnARerunIsNotARegression(t *testing.T) {
	output := "check:tests: 1 file(s) failed once and passed on a re-run: tests/m8/app-shell-ux.part-04.test.ts\n" +
		"  - tests/m8/app-shell-ux.part-04.test.ts [timing]\n" +
		"      × some shell layout case — Error: Test timed out in 30000ms. If this is a long-running test, pass a timeout value\n" +
		"check:tests: 3 file(s) failed twice, so the gate stops here:\n" +
		"  - tests/e2e/desktop-crash-recovery.test.ts\n" +
		"  - tests/e2e/desktop-shell.test.ts\n" +
		"  - tests/e2e/provider-independent-reviews.test.ts\n" +
		"      × [timing] a killed app restarts on the same conversation with a real crash reason while its daemon and lanes keep working — Error: timed out after 120000ms waiting for the master to create the graph at waitFor (/tmp/graph-async-full-1/tests/e2e/desktop-crash-recovery.fixture.ts:73:9)\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if !verdict.Environment {
		t.Fatalf("a file the runner re-ran and passed was called a regression: %+v", verdict)
	}
	if len(verdict.Unmatched) != 0 {
		t.Fatalf("the re-run file was reported as unmatched: %v", verdict.Unmatched)
	}
	if len(verdict.Flaky) != 1 || !strings.Contains(verdict.Flaky[0], "app-shell-ux.part-04") {
		t.Fatalf("the re-run file was not reported separately: %v", verdict.Flaky)
	}
}

func TestAsyncFullFlakyFileIsStillReportedEvenWithNoOtherFailure(t *testing.T) {
	output := "check:tests: 1 file(s) failed once and passed on a re-run: tests/m8/app-shell-ux.part-04.test.ts\n"
	verdict := ClassifyAsyncFull(output, knownReds())
	if len(verdict.Flaky) != 1 {
		t.Fatalf("a lone re-run file was dropped: %+v", verdict)
	}
	if len(verdict.Unmatched) != 0 {
		t.Fatalf("a lone re-run file was called a regression: %v", verdict.Unmatched)
	}
}

func TestADiskFullRunIsAnEnvironmentFailureEvenWhenFilesDoNotMatchTheKnownRedList(t *testing.T) {
	output := strings.Join([]string{
		" FAIL  tests/e2e/go-acceptance-binding.test.ts > an acceptance item binds",
		"Error: expected 'operations=[]' to be '' // Object.is equality",
		" FAIL  tests/e2e/go-operation-verdict.test.ts > never settled",
		"Error: ENOSPC: no space left on device, mkdtemp '/tmp/graph-e2e-x'",
	}, "\n")

	verdict := ClassifyAsyncFull(output, nil)
	if !verdict.Environment {
		t.Fatalf("a run that could not write its fixtures is an environment failure, not a regression: %+v", verdict)
	}
	if !strings.Contains(verdict.Reason, "磁盘") {
		t.Fatalf("the verdict must name the machine condition it saw: %q", verdict.Reason)
	}
}
