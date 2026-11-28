package main

import (
	"testing"
)

// Every call in a run must own a line that names what it touched. A tool the
// activity list has no special case for used to render as a bare "read已完成",
// which loses the file it read and makes two different calls look identical.
func TestAToolOutsideTheKnownFamiliesStillNamesItsTarget(t *testing.T) {
	run := transcriptRun{tools: true, messages: []transcriptMessage{
		activityTool("read", "read: /tmp/notes.md", "done"),
		activityTool("get_task_status", "get_task_status: task 72eed828", "done"),
	}}
	activities := codexActivities(run)
	if len(activities) != 2 {
		t.Fatalf("both calls own a line, got %d: %+v", len(activities), activities)
	}
	want := []string{"已调用 read /tmp/notes.md", "已调用 get_task_status task 72eed828"}
	for index, text := range want {
		if activities[index].text != text {
			t.Fatalf("line %d reads %q, want %q", index, activities[index].text, text)
		}
	}
}

// A codemode call carries its program in the args, not in its text. The line must
// show which program ran, or the reader cannot tell one codemode step from the
// next across a ninety-call round.
func TestACodemodeCallShowsTheProgramItRan(t *testing.T) {
	call := activityTool("codemode", "codemode: const hits = await searchTools(\"work\");", "done")
	call.Data.Args = `{"code":"const hits = await searchTools(\"work\", { limit: 20 });\nconsole.log(hits);\n"}`
	activities := codexActivities(transcriptRun{tools: true, messages: []transcriptMessage{call}})
	if len(activities) != 1 {
		t.Fatalf("the codemode call owns a line, got %+v", activities)
	}
	if activities[0].text == "已调用 codemode" {
		t.Fatalf("the line names no program at all: %q", activities[0].text)
	}
	if !contains(activities[0].text, "searchTools") {
		t.Fatalf("the line must name the program it ran, got %q", activities[0].text)
	}
}

// A failed call must say so on its own line: a fold that reports success for a
// call that errored is worse than a fold that omits it.
func TestAFailedToolCallIsNotReportedAsDone(t *testing.T) {
	call := activityTool("read", "read: /tmp/missing.md", "failed")
	call.Data.Error = true
	activities := codexActivities(transcriptRun{tools: true, messages: []transcriptMessage{call}})
	if len(activities) != 1 {
		t.Fatalf("the failed call owns a line, got %+v", activities)
	}
	if activities[0].text == "已调用 read /tmp/missing.md" {
		t.Fatalf("a failed call must not read as done: %q", activities[0].text)
	}
}
