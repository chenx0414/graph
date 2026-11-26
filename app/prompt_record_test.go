package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const promptRecordPayload = `{"taskId":"t1","nodeId":"master","kind":"agent","action":"master",
 "recorded":{"operationId":"op-1","at":1700000000000,"text":"SUPERVISOR-PROMPT-EXACT: 你好 <>&","tools":"[{\"name\":\"bash\",\"description\":\"run\"},{\"name\":\"read\",\"description\":\"read files\"}]"},
 "briefing":null,"notes":[]}`

const promptRecordEmptyPayload = `{"taskId":"t1","nodeId":"master","kind":"agent","action":"master","recorded":null,"briefing":null,
 "notes":["尚无实际模型发送记录。"]}`

func promptRecordShell(t *testing.T, promptPayload string) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations/c1/trajectory":
			_, _ = w.Write([]byte(contextOverviewTrajectory))
		case "/api/conversations/c1":
			_, _ = w.Write([]byte(`{"conversationId":"c1","projectRoot":"/tmp/project","messages":[]}`))
		case "/api/tasks/t1/nodes/master/prompt":
			_, _ = w.Write([]byte(promptPayload))
		case "/api/settings":
			_, _ = w.Write([]byte(contextOverviewSettings))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	shell := newShellState(server.URL, "tok")
	shell.selectConversation("c1")
	shell.ensureTrajectory()
	shell.ensureModelMeta()
	deadline := time.Now().Add(2 * time.Second)
	for (shell.trajectory.data == nil || shell.modelMeta == nil) && time.Now().Before(deadline) {
		frames(newTester(shell.view, 1440, 900))
	}
	shell.openModule("trajectory")
	tester := frames(newTester(shell.view, 1440, 900))
	for shell.promptRecord == nil && time.Now().Before(deadline) {
		render(tester)
	}
	if shell.promptRecord == nil {
		t.Fatalf("the recorded prompt never loaded: %q", shell.promptError)
	}
	return shell
}

func TestTheContextCardShowsThePromptTheModelActuallyReceived(t *testing.T) {
	shell := promptRecordShell(t, promptRecordPayload)
	tester := frames(newTester(shell.view, 1440, 900))
	for _, tab := range []string{"上下文", "System Prompt", "工具声明"} {
		if !tester.HasText(tab) {
			t.Fatalf("the context card offers the %q tab, texts %q", tab, tester.Texts())
		}
	}
	if err := tester.Click("System Prompt"); err != nil {
		t.Fatalf("open the system prompt tab: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("SUPERVISOR-PROMPT-EXACT: 你好 <>&") {
		t.Fatalf("the tab shows the system prompt byte for byte, texts %q", tester.Texts())
	}
	if !tester.HasText("实际发出（最近一次模型请求）") {
		t.Fatalf("the tab says where the text came from, texts %q", tester.Texts())
	}
	joined := strings.Join(tester.Texts(), "\n")
	if !strings.Contains(joined, "字符") {
		t.Fatalf("the tab shows the prompt length, texts %q", tester.Texts())
	}
}

func TestTheToolsTabShowsTheRecordedDeclarations(t *testing.T) {
	shell := promptRecordShell(t, promptRecordPayload)
	tester := frames(newTester(shell.view, 1440, 900))
	if err := tester.Click("工具声明"); err != nil {
		t.Fatalf("open the tools tab: %v", err)
	}
	tester = frames(tester)
	joined := strings.Join(tester.Texts(), "\n")
	for _, want := range []string{"实际发送的工具声明", `"name": "bash"`, `"name": "read"`, "2 个工具"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("the tools tab shows %q, texts %q", want, joined)
		}
	}
}

func TestAnUnrecordedPromptSaysSo(t *testing.T) {
	shell := promptRecordShell(t, promptRecordEmptyPayload)
	tester := frames(newTester(shell.view, 1440, 900))
	if err := tester.Click("System Prompt"); err != nil {
		t.Fatalf("open the system prompt tab: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("尚无实际模型发送记录。") {
		t.Fatalf("an unrecorded prompt says so, texts %q", tester.Texts())
	}
}

func TestAnOldNoteDoesNotHideTheRecordedPrompt(t *testing.T) {
	shell := promptRecordShell(t, `{"taskId":"t1","nodeId":"master","kind":"agent","action":"master",
	 "recorded":{"operationId":"op-1","at":1700000000000,"text":"PROMPT-WITH-NOTE","tools":null},
	 "briefing":null,"notes":["该节点没有自己的会话，简报无法找回。"]}`)
	tester := frames(newTester(shell.view, 1440, 900))
	if err := tester.Click("System Prompt"); err != nil {
		t.Fatalf("open the system prompt tab: %v", err)
	}
	tester = frames(tester)
	if !tester.HasText("PROMPT-WITH-NOTE") {
		t.Fatalf("the recorded prompt stays visible next to a note, texts %q", tester.Texts())
	}
}

func TestANodeChatReadsThatNodesOwnPrompt(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"a1","role":"assistant","kind":"message","text":"节点在跑","createdAt":1}],"hasOlder":false}`,
		prompt: `{"taskId":"tA","nodeId":"n2","kind":"agent","action":"build",
		 "recorded":{"operationId":"op-9","at":1700000000000,"text":"NODE-OWN-PROMPT","tools":"[]"},"briefing":null,"notes":[]}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.openFleetAgentChat(node)
	tester = frames(tester)
	state.promptRecord = nil
	state.ensurePromptRecord()
	deadline := time.Now().Add(2 * time.Second)
	for state.promptRecord == nil && time.Now().Before(deadline) {
		render(tester)
	}
	if state.promptRecord == nil || state.promptRecord.Recorded == nil || state.promptRecord.Recorded.Text != "NODE-OWN-PROMPT" {
		t.Fatalf("the node chat reads the node's own prompt, got %+v (%q)", state.promptRecord, state.promptError)
	}
	target := state.promptScope
	if target != "tA/n2" {
		t.Fatalf("the prompt target follows the node scope, got %q", target)
	}
}
