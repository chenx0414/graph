package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
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
			if r.Header.Get("Origin") != "http://"+r.Host {
				w.WriteHeader(http.StatusForbidden)
				return
			}
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
		{Role: "tool", State: "done", Data: transcriptMessageData{Tool: "bash"}},
		{Role: "tool", State: "done", Data: transcriptMessageData{Tool: "bash"}},
		{Role: "tool", State: "running", Data: transcriptMessageData{Tool: "edit"}},
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
}

func TestLegacyReloadReceiptsStayOutOfTheChat(t *testing.T) {
	messages, err := parseConversationMessages([]byte(`{"messages":[
		{"role":"assistant","text":"RSI 改动已提交，等待重载。","data":{"reloadReceipt":true}},
		{"role":"assistant","text":"真正的回答"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Text != "真正的回答" {
		t.Fatalf("a reload receipt is machinery, not chat: %+v", messages)
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

func TestToolRunsExpandAndCollapse(t *testing.T) {
	messages := []transcriptMessage{
		{Role: "tool", State: "done", Text: "bash: ls", Data: transcriptMessageData{Tool: "bash", ToolCallID: "call-1"}},
	}
	state := newChatState("http://127.0.0.1:1", "tok")
	state.messages = messages
	state.status = ""
	tester := ui.NewTester(state.view, 700, 500)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if tester.HasText("已运行 ls") {
		t.Fatalf("a folded run must not show its commands, texts %q", tester.Texts())
	}
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("open the run: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if !tester.HasText("已运行 ls") {
		t.Fatalf("an open run shows its commands, texts %q", tester.Texts())
	}
	if err := tester.Click("1 次工具调用"); err != nil {
		t.Fatalf("fold the run: %v", err)
	}
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	if tester.HasText("已运行 ls") {
		t.Fatalf("a folded run hides its commands again, texts %q", tester.Texts())
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

func TestTheQuestionModuleShowsTheQuestionAndAnswersIt(t *testing.T) {
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

	chat := newChatState(server.URL, "tok")
	chat.open("c1")
	if len(chat.questions) != 1 {
		t.Fatalf("questions %+v", chat.questions)
	}
	state := newShellState(server.URL, "tok")
	state.chat = chat
	state.activeID = "c1"
	state.board.pages = []boardPage{{ID: "board", Title: boardDefaultTitle, Panels: []boardPanel{{ID: "questions", Kind: "questions"}}, Layout: boardNode{Kind: "panel", PanelID: "questions"}}}
	tester := ui.NewTester(state.view, 1100, 760)
	frames(tester)
	if !tester.HasText("需要你决定 · recovery") || !tester.HasText("A 路线") {
		t.Fatalf("the question module must render, texts %q", tester.Texts())
	}
	if err := tester.Click("B 路线"); err != nil {
		t.Fatalf("click an answer: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for answered == "" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !contains(answered, "q1") || !contains(answered, "B 路线") || !contains(answered, "requestId") {
		t.Fatalf("answer body %q", answered)
	}
}

func TestChatBubblesCarryATimeAndACopyButton(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	stamp := time.Date(2026, 11, 11, 9, 5, 0, 0, time.Local).UnixMilli()
	state.messages = []transcriptMessage{
		{Role: "assistant", Text: "一句回答", CreatedAt: stamp},
		{Role: "user", Text: "一句提问", CreatedAt: stamp},
	}
	tester := ui.NewTester(state.view, 760, 620)
	frames(tester)
	if !tester.HasText("09:05") {
		t.Fatalf("a bubble must show the time it was sent, texts %q", tester.Texts())
	}
	copies := 0
	for _, text := range tester.Texts() {
		if text == "复制" {
			copies++
		}
	}
	if copies != 2 {
		t.Fatalf("every bubble must offer its copy button, got %d, texts %q", copies, tester.Texts())
	}
	if tester.HasText("agent") || tester.HasText("你") {
		t.Fatalf("bubbles carry no author line, texts %q", tester.Texts())
	}
}

func TestTheUserBubbleIsLightBlue(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	state.messages = []transcriptMessage{
		{Role: "assistant", Text: "一句回答", CreatedAt: time.Now().UnixMilli()},
		{Role: "user", Text: "一句提问", CreatedAt: time.Now().UnixMilli()},
	}
	light := frames(ui.NewTester(state.view, 760, 620))
	if got := countColor(light.Image(), userBubble(gwtheme.Light())); got < 300 {
		t.Fatalf("the user bubble takes the reference blue, %d pixels", got)
	}
	dark := ui.NewTester(state.view, 760, 620)
	dark.SetDark(true)
	frames(dark)
	if got := countColor(dark.Image(), userBubble(gwtheme.Dark())); got < 300 {
		t.Fatalf("the user bubble keeps a blue tint in the dark, %d pixels", got)
	}
}

func TestTheChatOffersABackToLatestButtonWhenScrolledUp(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	for index := 0; index < 40; index++ {
		state.messages = append(state.messages, transcriptMessage{ID: "m" + strconv.Itoa(index), Role: "assistant", Text: "第" + strconv.Itoa(index) + "条"})
	}
	tester := frames(ui.NewTester(state.view, 700, 500))
	if tester.HasText("回到最新") {
		t.Fatalf("at the end no back-to-latest button shows, texts %q", tester.Texts())
	}
	state.list.ScrollTo(0, ui.Start)
	frames(tester)
	if !tester.HasText("回到最新") {
		t.Fatalf("scrolled up, the chat offers the way back to the latest, texts %q", tester.Texts())
	}
	if err := tester.Click("回到最新"); err != nil {
		t.Fatalf("click 回到最新: %v", err)
	}
	frames(tester)
	if tester.HasText("回到最新") {
		t.Fatalf("back at the end the button goes away, texts %q", tester.Texts())
	}
	first, last := state.list.Visible()
	if !state.list.AtEnd() {
		t.Fatalf("the click returns the chat to its end, visible %d..%d", first, last)
	}
}

func TestAssistantMessagesAreFlatMarkdownWithActions(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	state.status = ""
	state.messages = []transcriptMessage{
		{Role: "assistant", Text: "一句回答", CreatedAt: time.Now().UnixMilli()},
		{Role: "user", Text: "一句提问", CreatedAt: time.Now().UnixMilli()},
	}
	tester := frames(ui.NewTester(state.view, 760, 620))
	for _, label := range []string{"赞", "踩", "朗读", "更多"} {
		if !tester.HasText(label) {
			t.Fatalf("the assistant message carries the reference actions, missing %q, texts %q", label, tester.Texts())
		}
	}
	answer, ok := tester.Find("一句回答")
	if !ok {
		t.Fatalf("the answer never rendered, texts %q", tester.Texts())
	}
	question, ok := tester.Find("一句提问")
	if !ok {
		t.Fatalf("the question never rendered, texts %q", tester.Texts())
	}
	if answer.X > 24 {
		t.Fatalf("the answer lies flat on the pane, not in a bubble, left edge %v", answer.X)
	}
	if question.X <= answer.X+100 {
		t.Fatalf("the question keeps its bubble on the right, answer %v question %v", answer.X, question.X)
	}
}
