package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestParseConversationsSkipsArchived(t *testing.T) {
	list, err := parseConversations([]byte(`[
		{"id":"a","title":"第一个","status":"chatting","archivedAt":null},
		{"id":"b","title":"归档的","status":"archived","archivedAt":1794000000000}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Title != "第一个" {
		t.Fatalf("list %+v", list)
	}
	if list[0].ArchivedAtPresent() || !list[1].ArchivedAtPresent() {
		t.Fatal("archivedAt must decide what the list shows")
	}
	if _, err := parseConversations([]byte("{")); err == nil {
		t.Fatal("garbage must be reported")
	}
}

func TestParseConversationMessagesKeepsSpokenRolesOnly(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
		{"role":"user","text":"你好"},
		{"role":"tool","text":"{\"ok\":true}"},
		{"role":"assistant","kind":"chat","text":"**结论。**后文"},
		{"role":"assistant","text":"   "}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 3 || messages[0].Text != "你好" || messages[1].Role != "tool" || messages[2].Role != "assistant" {
		t.Fatalf("tool messages must survive parsing so the view can show them: %+v", messages)
	}
}

func TestChatStateReadsTheDaemonAndRenders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "graph_session=tok" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[{"id":"c1","title":"会话一","status":"chatting","archivedAt":null}]`))
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"user","text":"你好"},{"role":"assistant","text":"**结论。**后文"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok\n")
	state.open("c1")
	if state.status != "" {
		t.Fatalf("status %q", state.status)
	}
	if len(state.messages) != 2 {
		t.Fatalf("messages %+v", state.messages)
	}
	tester := ui.NewTester(state.view, 720, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("你好") {
		t.Fatalf("the user message is missing, texts %q", tester.Texts())
	}
	if !tester.HasText("结论。后文") {
		t.Fatalf("the markdown reply did not render, texts %q", tester.Texts())
	}
}

func TestChatStateSendsAndReadsTheAnswerBack(t *testing.T) {
	posted := ""
	sent := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/conversations/c1/messages":
			payload := make([]byte, 1024)
			read, _ := r.Body.Read(payload)
			posted = string(payload[:read])
			sent = true
			w.Write([]byte(`{"accepted":true}`))
		case r.URL.Path == "/api/conversations/c1":
			if sent {
				w.Write([]byte(`{"messages":[{"role":"user","text":"再来一句"},{"role":"assistant","text":"答复到了"}]}`))
				return
			}
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"旧的"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if state.active != "c1" || state.status != "" {
		t.Fatalf("active %q status %q", state.active, state.status)
	}
	state.draft = "再来一句"
	state.send()
	if posted == "" || !contains(posted, "再来一句") || !contains(posted, "requestId") {
		t.Fatalf("posted body %q", posted)
	}
	if state.draft != "" {
		t.Fatal("the composer must clear after a send")
	}
	if len(state.messages) != 2 || state.messages[1].Text != "答复到了" {
		t.Fatalf("messages %+v", state.messages)
	}
	if state.status != "" {
		t.Fatalf("status %q after the answer arrived", state.status)
	}
}

func TestChatStateKeepsAStatusWhileTheAnswerIsPending(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Write([]byte(`{}`))
			return
		}
		w.Write([]byte(`{"messages":[{"role":"user","text":"发出去的"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	state.draft = "发出去的"
	state.send()
	if state.status != "已发出，等待回复…" {
		t.Fatalf("status %q", state.status)
	}
}

func contains(haystack, needle string) bool {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestMessageStreamingFollowsTheStateField(t *testing.T) {
	if !messageStreaming(transcriptMessage{Role: "assistant", State: "streaming"}) {
		t.Fatal("a streaming assistant message must render with Stream")
	}
	if messageStreaming(transcriptMessage{Role: "assistant", State: "done"}) {
		t.Fatal("a finished reply must render with View")
	}
	if messageStreaming(transcriptMessage{Role: "user", State: "streaming"}) {
		t.Fatal("only assistant messages stream")
	}
}

func TestFollowStopsWhenTheReplyLands(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.Write([]byte(`{"messages":[{"role":"user","text":"问"},{"role":"assistant","state":"streaming","text":"半句"}]}`))
			return
		}
		w.Write([]byte(`{"messages":[{"role":"user","text":"问"},{"role":"assistant","state":"done","text":"完整答复"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.active = "c1"
	state.follow()
	if calls < 3 {
		t.Fatalf("the follower stopped too early (%d polls)", calls)
	}
	if len(state.messages) != 2 || state.messages[1].Text != "完整答复" {
		t.Fatalf("messages %+v", state.messages)
	}
}

func TestToolCallsGroupIntoOneRowPerRun(t *testing.T) {
	messages := []transcriptMessage{
		{Role: "user", Text: "跑一下"},
		{Role: "tool", State: "done", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "bash"}},
		{Role: "tool", State: "done", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "bash"}},
		{Role: "tool", State: "running", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "edit"}},
		{Role: "assistant", Kind: "chat", Text: "好了"},
	}
	runs := groupRuns(messages)
	if len(runs) != 3 {
		t.Fatalf("runs %d: %+v", len(runs), runs)
	}
	if runs[0].tools || !runs[1].tools || runs[2].tools {
		t.Fatalf("alternation broken: %+v", runs)
	}
	if len(runs[1].messages) != 3 {
		t.Fatalf("consecutive tool calls must share one run, got %d", len(runs[1].messages))
	}
	if summary := runSummary(runs[1]); summary != "bash, edit · 进行中" {
		t.Fatalf("summary %q", summary)
	}
	finished := transcriptRun{tools: true, messages: messages[1:2]}
	if summary := runSummary(finished); summary != "bash" {
		t.Fatalf("a finished run must not say 进行中: %q", summary)
	}
}

func TestToolMessagesSurviveParsingSoTheViewCanGroupThem(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
		{"role":"tool","kind":"tool","state":"done","text":"bash: ls","data":{"tool":"bash","toolCallId":"t1","ordinal":1}},
		{"role":"assistant","text":"看完了"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Role != "tool" || messages[0].Data.Tool != "bash" {
		t.Fatalf("messages %+v", messages)
	}
	if summary := runSummary(transcriptRun{tools: true, messages: messages[:1]}); summary != "bash" {
		t.Fatalf("summary %q", summary)
	}
}

func TestSpokenMessagesNeverMergeIntoOneRun(t *testing.T) {
	messages := []transcriptMessage{
		{Role: "user", Text: "第一句"},
		{Role: "assistant", Kind: "chat", Text: "答复"},
		{Role: "user", Text: "第二句"},
	}
	runs := groupRuns(messages)
	if len(runs) != 3 {
		t.Fatalf("spoken messages must stay separate rows, got %d runs: %+v", len(runs), runs)
	}
	for index, run := range runs {
		if run.tools || len(run.messages) != 1 || run.messages[0].Text != messages[index].Text {
			t.Fatalf("run %d = %+v", index, run)
		}
	}
	if len(groupRuns([]transcriptMessage{{Role: "assistant", Text: "只有一条"}})) != 1 {
		t.Fatal("a single message is one run")
	}
}

func TestToolLineShowsNameStateAndATrimmedCommand(t *testing.T) {
	line := toolLine(transcriptMessage{Role: "tool", State: "done", Text: "bash: cd /repo\ngit status", Data: struct {
		Tool       string `json:"tool"`
		ToolCallID string `json:"toolCallId"`
		Ordinal    int    `json:"ordinal"`
	}{Tool: "bash"}})
	if line != "bash · 完成 · cd /repo" {
		t.Fatalf("line %q", line)
	}
	long := ""
	for index := 0; index < 200; index++ {
		long += "字"
	}
	clipped := toolLine(transcriptMessage{Role: "tool", State: "running", Text: long})
	if len([]rune(clipped)) > 110 || !contains(clipped, "进行中") {
		t.Fatalf("clipped %q", clipped)
	}
	if toolLine(transcriptMessage{Role: "tool", State: "done"}) != "tool · 完成" {
		t.Fatalf("an empty text keeps name and state only: %q", toolLine(transcriptMessage{Role: "tool", State: "done"}))
	}
}

func TestToolRunsExpandAndCollapse(t *testing.T) {
	messages := []transcriptMessage{
		{Role: "tool", State: "done", Text: "bash: ls", Data: struct {
			Tool       string `json:"tool"`
			ToolCallID string `json:"toolCallId"`
			Ordinal    int    `json:"ordinal"`
		}{Tool: "bash", ToolCallID: "call-1"}},
	}
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = messages
	state.status = ""
	tester := ui.NewTester(state.view, 700, 500)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if tester.HasText("bash · 完成 · ls") {
		t.Fatal("a collapsed run must not show its commands")
	}
	state.expanded[runKey(groupRuns(messages)[0])] = true
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("bash · 完成 · ls") {
		t.Fatalf("an expanded run must show its commands, texts %q", tester.Texts())
	}
}

func TestWindowStartKeepsTheTailVisible(t *testing.T) {
	if start := windowStart(10, 40); start != 0 {
		t.Fatalf("a short transcript starts at 0, got %d", start)
	}
	if start := windowStart(100, 40); start != 60 {
		t.Fatalf("the window shows the last 40, got start %d", start)
	}
	if start := windowStart(0, 0); start != 0 {
		t.Fatalf("an empty transcript starts at 0, got %d", start)
	}
	if start := windowStart(5, 0); start != 0 {
		t.Fatalf("an unset window falls back to the default, got %d", start)
	}
}

func TestLongTranscriptsOfferOlderRunsOnDemand(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	for index := 0; index < 45; index++ {
		state.messages = append(state.messages, transcriptMessage{Role: "user", Text: "第" + strconv.Itoa(index) + "句"})
	}
	tester := ui.NewTester(state.view, 700, 500)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	joined := ""
	for _, text := range tester.Texts() {
		joined += text
	}
	if !contains(joined, "加载更早的 5 段") {
		t.Fatalf("the window must offer the older runs, texts %q", tester.Texts())
	}
	if !tester.HasText("第44句") {
		t.Fatalf("the newest message must show, texts %q", tester.Texts())
	}
	if start := windowStart(45, 45+transcriptWindow); start != 0 {
		t.Fatalf("loading more must reach the first run, got start %d", start)
	}
}

func TestOnlyUnresolvedQuestionsAreShown(t *testing.T) {
	payload := []byte(`{"messages":[],"questions":[
		{"id":"q1","kind":"recovery","status":"open","suspended":true,"taskId":"t1","data":{"prompt":"**选一条**","options":["A 路线","B 路线"]}},
		{"id":"q2","kind":"recovery","status":"resolved","suspended":true,"taskId":"t1","data":{"prompt":"已答复"}}
	]}`)
	body, err := parseConversationBody(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(body.Questions) != 2 || !body.Questions[0].open() || body.Questions[1].open() {
		t.Fatalf("questions %+v", body.Questions)
	}
	if body.Questions[0].Data.Options[1] != "B 路线" {
		t.Fatalf("options %v", body.Questions[0].Data.Options)
	}
}

func TestNativeWindowShowsTheQuestionAndAnswersIt(t *testing.T) {
	answered := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/tasks/t1/answer":
			payload := make([]byte, 2048)
			read, _ := r.Body.Read(payload)
			answered = string(payload[:read])
			w.Write([]byte(`{}`))
		case r.URL.Path == "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"等我问一句"}],"questions":[{"id":"q1","kind":"recovery","status":"open","suspended":true,"taskId":"t1","data":{"prompt":"**选一条**","options":["A 路线","B 路线"]}}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.questions) != 1 {
		t.Fatalf("questions %+v", state.questions)
	}
	tester := ui.NewTester(state.view, 760, 620)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("需要你决定 · recovery") || !tester.HasText("A 路线") {
		t.Fatalf("the question card must render, texts %q", tester.Texts())
	}
	state.answer(state.questions[0], "B 路线")
	if !contains(answered, "q1") || !contains(answered, "B 路线") || !contains(answered, "requestId") {
		t.Fatalf("answer body %q", answered)
	}
}
