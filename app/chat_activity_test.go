package main

import (
	"testing"
	"time"
)

func activityTool(name, text, state string) transcriptMessage {
	message := transcriptMessage{Role: "tool", Kind: "tool", Text: text, State: state}
	message.Data.Tool = name
	return message
}

func TestCodexActivitiesSummarizeAToolRun(t *testing.T) {
	run := transcriptRun{tools: true, messages: []transcriptMessage{
		activityTool("bash", "bash: echo hi", "done"),
		activityTool("bash", "bash: go test ./...", "done"),
		activityTool("view_image", "view_image: a.png", "done"),
		activityTool("apply_patch", "apply_patch: app/main.go", "done"),
		activityTool("graph_inspect", "graph_inspect: graph_inspect", "done"),
	}}
	activities := codexActivities(run)
	want := []string{"已运行 echo hi; go test ./...", "已查看 1 张图像", "已编辑 app/main.go", "已调用 graph_inspect graph_inspect"}
	if len(activities) != len(want) {
		t.Fatalf("activities %+v", activities)
	}
	for index, text := range want {
		if activities[index].text != text {
			t.Fatalf("activity %d is %q, want %q", index, activities[index].text, text)
		}
	}
	if activities[0].kind != "command" || activities[1].kind != "image" || activities[2].kind != "edit" || activities[3].kind != "tool" {
		t.Fatalf("activity kinds %+v", activities)
	}
}

func TestCodexWorkedForFormatsDurations(t *testing.T) {
	cases := map[time.Duration]string{
		45 * time.Second:             "45s",
		181 * time.Second:            "3m 1s",
		time.Hour + 2*time.Minute:    "1h 2m",
		3*time.Hour + 40*time.Minute: "3h 40m",
		time.Millisecond:             "1s",
	}
	for elapsed, want := range cases {
		if got := codexWorkedFor(elapsed); got != want {
			t.Fatalf("%s formats as %q, want %q", elapsed, got, want)
		}
	}
}

func TestTheToolActivityStartsFoldedUnderItsDurationHeader(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	first := activityTool("bash", "bash: echo hi", "done")
	first.CreatedAt = 1_000_000
	second := activityTool("bash", "bash: go test ./...", "done")
	second.CreatedAt = 1_181_000
	state.messages = []transcriptMessage{first, second}
	tester := frames(newTester(state.view, 760, 620))
	if !tester.HasText("用时 3m 1s") {
		t.Fatalf("the run shows its duration header, texts %q", tester.Texts())
	}
	if tester.HasText("已运行 echo hi; go test ./...") {
		t.Fatalf("the activity starts folded, texts %q", tester.Texts())
	}
	if err := tester.Click("用时 3m 1s"); err != nil {
		t.Fatalf("open the activity: %v", err)
	}
	frames(tester)
	if !tester.HasText("已运行 echo hi; go test ./...") {
		t.Fatalf("opening lists the commands, texts %q", tester.Texts())
	}
	if err := tester.Click("用时 3m 1s"); err != nil {
		t.Fatalf("fold the activity: %v", err)
	}
	frames(tester)
	if tester.HasText("已运行 echo hi; go test ./...") {
		t.Fatalf("folding hides the rows again, texts %q", tester.Texts())
	}
}

func TestCodexActivityCarriesCommandOutputForThePanel(t *testing.T) {
	message := activityTool("bash", "bash: echo hi", "done")
	message.Data.Output = "hi"
	message.Data.ToolCallID = "call-1"
	activities := codexActivities(transcriptRun{tools: true, messages: []transcriptMessage{message}})
	if len(activities) != 1 {
		t.Fatalf("activities %+v", activities)
	}
	activity := activities[0]
	if activity.label != "Shell" || activity.command != "echo hi" || activity.output != "hi" || activity.failed {
		t.Fatalf("the activity carries its panel data, got %+v", activity)
	}
}

func TestAToolRowExpandsIntoTheCodexPanel(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	message := activityTool("bash", "bash: echo hi", "done")
	message.Data.Output = "hi there"
	message.Data.ToolCallID = "call-1"
	message.CreatedAt = 1_000_000
	state.messages = []transcriptMessage{message}
	tester := frames(newTester(state.view, 760, 620))
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("open the activity: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("已运行 echo hi") {
		t.Fatalf("the row shows its command, texts %q", tester.Texts())
	}
	if tester.HasText("Shell") {
		t.Fatalf("the panel is closed until the row is clicked, texts %q", tester.Texts())
	}
	if err := tester.Click("已运行 echo hi"); err != nil {
		t.Fatalf("expand the row: %v", err)
	}
	frames(tester)
	for _, want := range []string{"Shell", "$ echo hi", "hi there", "成功"} {
		if !tester.HasText(want) {
			t.Fatalf("the panel shows %q, texts %q", want, tester.Texts())
		}
	}
}

func TestAToolRowShowsItsArgumentsAndReturnValue(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	message := activityTool("graph_inspect", "graph_inspect: graph_inspect", "done")
	message.Data.Args = `{"query":"SELECT 1"}`
	message.Data.Output = "answer"
	message.Data.ToolCallID = "call-2"
	message.CreatedAt = 1_000_000
	state.messages = []transcriptMessage{message}
	tester := frames(newTester(state.view, 760, 620))
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("open the activity: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("已调用 graph_inspect SELECT 1"); err != nil {
		t.Fatalf("open the tool row: %v", err)
	}
	tester = frames(tester)
	for _, want := range []string{"graph_inspect", "参数", `{"query":"SELECT 1"}`, "输出", "answer", "成功"} {
		if !tester.HasText(want) {
			t.Fatalf("the panel shows %q, texts %q", want, tester.Texts())
		}
	}
}

func TestAShellRowKeepsItsCommandOutOfTheArgumentsBlock(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	message := activityTool("bash", "bash: echo hi", "done")
	message.Data.Args = `{"command":"echo hi","timeout":15000}`
	message.Data.Output = "hi"
	message.Data.ToolCallID = "call-3"
	message.CreatedAt = 1_000_000
	state.messages = []transcriptMessage{message}
	tester := frames(newTester(state.view, 760, 620))
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("open the activity: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("已运行 echo hi"); err != nil {
		t.Fatalf("open the shell row: %v", err)
	}
	tester = frames(tester)
	for _, want := range []string{"Shell", "$ echo hi", "输出", "hi"} {
		if !tester.HasText(want) {
			t.Fatalf("the panel shows %q, texts %q", want, tester.Texts())
		}
	}
	if tester.HasText("参数") {
		t.Fatalf("a shell command is not repeated as arguments, texts %q", tester.Texts())
	}
}

func TestAToolRowFallsBackToItsArgumentsForTheCommand(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	message := activityTool("bash", "bash: bash", "done")
	message.Data.Args = `{"command":"uname -s","timeout":15000}`
	message.Data.Output = "Darwin"
	message.Data.ToolCallID = "call-4"
	message.CreatedAt = 1_000_000
	state.messages = []transcriptMessage{message}
	tester := frames(newTester(state.view, 760, 620))
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("open the activity: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("已运行 uname -s") {
		t.Fatalf("the row reads its command from the arguments, texts %q", tester.Texts())
	}
}

func TestAGroupedCommandRowDoesNotRepeatItsArguments(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	first := activityTool("bash", "bash: echo hi", "done")
	first.Data.Args = `{"command":"echo hi","timeout":15000}`
	first.Data.Output = "hi"
	first.Data.ToolCallID = "call-5"
	first.CreatedAt = 1_000_000
	second := activityTool("bash", "bash: pwd", "done")
	second.Data.Args = `{"command":"pwd","timeout":15000}`
	second.Data.Output = "/repo"
	second.Data.ToolCallID = "call-6"
	second.CreatedAt = 1_001_000
	state.messages = []transcriptMessage{first, second}
	tester := frames(newTester(state.view, 760, 620))
	if err := tester.Click("用时 1s"); err != nil {
		t.Fatalf("open the activity: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("已运行 echo hi; pwd"); err != nil {
		t.Fatalf("open the grouped row: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("$ echo hi; pwd") || !tester.HasText("输出") {
		t.Fatalf("the panel shows the commands and their output, texts %q", tester.Texts())
	}
	if tester.HasText("参数") || tester.HasText(`{"command":"echo hi","timeout":15000}`) {
		t.Fatalf("the arguments block stays out of a shell row, texts %q", tester.Texts())
	}
}
