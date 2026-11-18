package main

import (
	"image"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/palette"
	gwtheme "graph/app/gwui/theme"
)

func fourPaneShell(t *testing.T) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[
				{"id":"g1","title":"Main","role":"global","archivedAt":null},
				{"id":"p1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null},
				{"id":"p2","title":"mygo","projectId":"mygo","role":"project","archivedAt":null},
				{"id":"old1","title":"旧聊天","projectId":"13-Graph","role":"legacy","archivedAt":null}
			]`))
		case "/api/conversations/g1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自主控"}],"tasks":[{"id":"t1","request":"实现四栏页面","status":"running","phase":"executing","nodes":[{"id":"planner","role":"worker","kind":"agent","status":"succeeded"},{"id":"worker","role":"worker","kind":"agent","status":"running"}]}]}`))
		case "/api/conversations/p1":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话一"}],"tasks":[{"id":"t1","request":"实现四栏页面","status":"running","phase":"executing","nodes":[{"id":"planner","role":"worker","kind":"agent","status":"succeeded"},{"id":"worker","role":"worker","kind":"agent","status":"running"}]}]}`))
		case "/api/conversations/p2":
			w.Write([]byte(`{"messages":[{"role":"assistant","text":"来自会话二"}]}`))
		case "/api/tasks/t1/graph":
			w.Write([]byte(`{"nodes":[{"id":"planner","kind":"agent","label":"planner","status":"succeeded"},{"id":"worker","kind":"agent","label":"worker","status":"running"}],"layout":{"positions":{"planner":{"x":40,"y":40,"width":160,"height":56},"worker":{"x":280,"y":170,"width":160,"height":56}},"edges":[{"id":"e1","source":"planner","target":"worker","points":[{"x":120,"y":96},{"x":120,"y":198},{"x":280,"y":198}]}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	return state
}

func frames(tester *ui.Tester) *ui.Tester {
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	return tester
}

func TestTheWindowShowsFourPanesLeftToRight(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))

	rail, ok := tester.Find("轨迹")
	if !ok {
		t.Fatalf("the function rail must show its home entry, texts %q", tester.Texts())
	}
	conversation, ok := tester.Find("13-Graph")
	if !ok {
		t.Fatalf("the project conversation area must list the project, texts %q", tester.Texts())
	}
	composer, ok := tester.Find("发送")
	if !ok {
		t.Fatalf("the chat pane must show its composer, texts %q", tester.Texts())
	}
	board, ok := tester.Find("白板")
	if !ok {
		t.Fatalf("the whiteboard must show its tabs, texts %q", tester.Texts())
	}
	if !(rail.X < conversation.X && conversation.X+conversation.W <= composer.X && composer.X < board.X) {
		t.Fatalf("panes out of order: rail %+v conversation %+v composer %+v board %+v", rail, conversation, composer, board)
	}
	if !tester.HasText("当前上下文窗口") || !tester.HasText("Agent 网络窗口") || !tester.HasText("跨 Agent 协作窗口") {
		t.Fatalf("the whiteboard must present the context, network and collaboration, texts %q", tester.Texts())
	}
	if !tester.HasText("来自主控") {
		t.Fatalf("the chat pane must open the main agent conversation, texts %q", tester.Texts())
	}
	if !tester.HasText("main agent") {
		t.Fatalf("the conversation area must pin the main agent, texts %q", tester.Texts())
	}
	if tester.HasText("旧聊天") {
		t.Fatalf("a legacy chat must stay out of the project conversation list, texts %q", tester.Texts())
	}
}

func TestTheMainAgentRowStandsOutFromTheProjects(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if !tester.HasText("main agent") {
		t.Fatalf("the main agent row must read as the agent, texts %q", tester.Texts())
	}
	for _, text := range tester.Texts() {
		if text == "主控 · 常驻" {
			t.Fatalf("the main agent row must carry no caption, texts %q", tester.Texts())
		}
	}
	if ink := countColor(tester.Image(), gwtheme.Light().Foreground); ink < 100 {
		t.Fatalf("the octopus must be drawn in theme ink, %d ink pixels", ink)
	}
	if violet := countColor(tester.Image(), palette.Violet100.Color()); violet != 0 {
		t.Fatalf("the octopus is monochrome now, %d violet pixels", violet)
	}
	if dot := countColor(tester.Image(), gwtheme.Light().Success); dot != 0 {
		t.Fatalf("the main agent row carries no status dot, %d green pixels", dot)
	}
}

func TestTheAppFocusesTheComposerOnOpen(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	tester.Type("你好")
	frames(tester)
	active := state.active()
	if active == nil || active.draft != "你好" {
		t.Fatalf("the composer must be focused when the app opens, active %v", active)
	}
}

func TestTheRailOpensATabForTheModule(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("click 设置: %v", err)
	}
	frames(tester)
	if kind := state.activeBoardKind(); kind != "settings" || !tester.HasText("运行设置") {
		t.Fatalf("the rail must open the settings tab: kind %q texts %q", kind, tester.Texts())
	}
	if err := tester.Click("白板"); err != nil {
		t.Fatalf("click the board tab: %v", err)
	}
	frames(tester)
	if kind := state.activeBoardKind(); kind != "" || !tester.HasText("当前上下文窗口") {
		t.Fatalf("the board tab must come back: kind %q texts %q", kind, tester.Texts())
	}
}

func TestTheShellFloatsOnAShadow(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	img := tester.Image()
	luminance := func(x, y int) int {
		at := img.PixOffset(x, y)
		return (int(img.Pix[at]) + int(img.Pix[at+1]) + int(img.Pix[at+2])) / 3
	}
	backdrop := luminance(4, 450)
	belowCard := luminance(700, 894)
	if belowCard >= backdrop-4 {
		t.Fatalf("the shell drops a shadow on the backdrop, backdrop %d below %d", backdrop, belowCard)
	}
	send, ok := tester.Find("发送")
	if !ok {
		t.Fatalf("the composer never rendered, texts %q", tester.Texts())
	}
	composerBottom := int(send.Y+send.H) + 15
	composerShadow := luminance(int(send.X+send.W/2), composerBottom)
	if composerShadow >= 250 {
		t.Fatalf("the composer sits above the chat with its own shadow, %d at y %d", composerShadow, composerBottom)
	}
}

func TestTheConversationHeaderStaysQuiet(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	countHeader := regexp.MustCompile(`^[0-9]+ 个会话$`)
	for _, text := range tester.Texts() {
		if countHeader.MatchString(text) {
			t.Fatalf("the conversation list header carries no count, texts %q", tester.Texts())
		}
	}
}

func TestTheThreeColumnsShareOneShellBand(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	listTitle, ok := tester.Find("会话列表标题")
	if !ok {
		t.Fatalf("the conversation list header never rendered, texts %q", tester.Texts())
	}
	chatTitle, ok := tester.Find("对话标题")
	if !ok {
		t.Fatalf("the chat header never rendered, texts %q", tester.Texts())
	}
	boardTitle, ok := tester.Find("白板标题")
	if !ok {
		t.Fatalf("the board header never rendered, texts %q", tester.Texts())
	}
	for name, rect := range map[string]ui.Rect{"list": listTitle, "chat": chatTitle, "board": boardTitle} {
		if rect.Y != listTitle.Y || rect.H != listTitle.H {
			t.Fatalf("every column header shares one band: %s %+v vs list %+v", name, rect, listTitle)
		}
	}
	if !(listTitle.X < chatTitle.X && chatTitle.X < boardTitle.X) {
		t.Fatalf("the columns line up left to right: list %+v chat %+v board %+v", listTitle, chatTitle, boardTitle)
	}
}

func TestTheWhiteboardHasTabsAndNoFloatingToolbar(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	for _, gone := range []string{"添加", "搜索", "网格", "聚焦", "重置"} {
		if tester.HasText(gone) {
			t.Fatalf("the floating toolbar is gone, %q still shows, texts %q", gone, tester.Texts())
		}
	}
	if !tester.HasText("白板") || tester.HasText("新建标签页") {
		t.Fatalf("the board keeps one tab and no plus, texts %q", tester.Texts())
	}
	if len(state.board.pages) != 1 || state.board.active != 0 || state.board.pages[0].Title != "白板" {
		t.Fatalf("the whiteboard is the only tab until a rail entry opens another, pages %d active %d", len(state.board.pages), state.board.active)
	}
}

func TestTheComposerFitsTheMinimumWindow(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1024, 640))
	for _, label := range []string{"轨迹", "13-Graph", "发送", "白板"} {
		rect, ok := tester.Find(label)
		if !ok {
			t.Fatalf("%s never rendered, texts %q", label, tester.Texts())
		}
		if rect.X < 0 || rect.Y < 0 || rect.X+rect.W > 1024 || rect.Y+rect.H > 640 {
			t.Fatalf("%s sits outside the window: %+v", label, rect)
		}
	}
}

func TestTabsSwitchAndCloseWithoutLosingTheBoard(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("open the settings tab: %v", err)
	}
	frames(tester)
	if err := tester.Click("设置"); err != nil {
		t.Fatalf("reopen the settings tab: %v", err)
	}
	frames(tester)
	if len(state.board.pages) != 2 {
		t.Fatalf("one rail entry owns one tab, pages %d", len(state.board.pages))
	}
	if err := tester.Click("关闭 运行设置"); err != nil {
		t.Fatalf("close the settings tab: %v", err)
	}
	frames(tester)
	if len(state.board.pages) != 1 || state.activeBoardKind() != "" {
		t.Fatalf("closing a tab returns to the board, pages %d kind %q", len(state.board.pages), state.activeBoardKind())
	}
	if !tester.HasText("当前上下文窗口") {
		t.Fatalf("the board comes back with its modules, texts %q", tester.Texts())
	}
}

func countColor(img *image.RGBA, want ui.Color) int {
	count := 0
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			at := img.PixOffset(x, y)
			if img.Pix[at] == want.R && img.Pix[at+1] == want.G && img.Pix[at+2] == want.B && img.Pix[at+3] == want.A {
				count++
			}
		}
	}
	return count
}

func TestTheFunctionRailStaysCompactAndCentered(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if railWidth > 40 {
		t.Fatalf("the rail must stay compact, width %.1f", railWidth)
	}
	center := float32(trafficLightPosition().X) + 6.5
	for _, label := range []string{"轨迹", "编队", "供应商", "资源", "装配", "设置"} {
		rect, ok := tester.Find(label)
		if !ok {
			t.Fatalf("the rail lost %q, texts %q", label, tester.Texts())
		}
		if delta := rect.X + rect.W/2 - center; delta < -0.5 || delta > 0.5 {
			t.Fatalf("%q sits off center: center %.1f rail center %.1f", label, rect.X+rect.W/2, center)
		}
	}
}

func TestTheFunctionRailSpacesItsIconsApart(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	previousBottom := float32(-1)
	for _, label := range []string{"轨迹", "编队", "供应商", "资源", "装配", "设置"} {
		rect, ok := tester.Find(label)
		if !ok {
			t.Fatalf("the rail lost %q, texts %q", label, tester.Texts())
		}
		if previousBottom >= 0 {
			if gap := rect.Y - previousBottom; gap < 10 {
				t.Fatalf("rail icons sit %.1f apart, want at least 10", gap)
			}
		}
		previousBottom = rect.Y + rect.H
	}
}

func TestTheFirstRailIconSharesTheMainAgentCardCenter(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	icon, ok := tester.Find("轨迹")
	if !ok {
		t.Fatalf("the rail lost its first icon, texts %q", tester.Texts())
	}
	card, ok := tester.Find("main agent 会话")
	if !ok {
		t.Fatalf("the main agent card never rendered, texts %q", tester.Texts())
	}
	iconCenter := icon.Y + icon.H/2
	cardCenter := card.Y + card.H/2
	if delta := iconCenter - cardCenter; delta < -1 || delta > 1 {
		t.Fatalf("the first rail icon center %.1f misses the card center %.1f", iconCenter, cardCenter)
	}
}

func TestTheRailTooltipSitsToTheRight(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	icon, ok := tester.Find("轨迹")
	if !ok {
		t.Fatalf("the rail lost its first icon, texts %q", tester.Texts())
	}
	darkIn := func(img *image.RGBA) int {
		x0, x1 := int(icon.X+icon.W+8), int(icon.X+icon.W+88)
		y0, y1 := int(icon.Y+icon.H/2-10), int(icon.Y+icon.H/2+10)
		count := 0
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				at := img.PixOffset(x, y)
				if int(img.Pix[at])+int(img.Pix[at+1])+int(img.Pix[at+2]) < 250 {
					count++
				}
			}
		}
		return count
	}
	before := darkIn(tester.Image())
	tester.Move(icon.X+icon.W/2, icon.Y+icon.H/2)
	tester.Advance(700 * time.Millisecond)
	tester.Frame()
	after := darkIn(tester.Image())
	if after < before+40 {
		t.Fatalf("no tip appears right of the icon: dark %d before, %d after", before, after)
	}
}

func TestTheMainAgentCardLooksSelectedWhenItsConversationIsOpen(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	card, ok := tester.Find("main agent 会话")
	if !ok {
		t.Fatalf("the main agent card never rendered, texts %q", tester.Texts())
	}
	luminance := func() int {
		img := tester.Image()
		at := img.PixOffset(int(card.X+12), int(card.Y+card.H/2))
		return (int(img.Pix[at]) + int(img.Pix[at+1]) + int(img.Pix[at+2])) / 3
	}
	selected := luminance()
	state.selectConversation("p1")
	frames(tester)
	inactive := luminance()
	if selected >= inactive-6 {
		t.Fatalf("the open main agent card must darken: selected %d inactive %d", selected, inactive)
	}
}

func TestTheMainAgentTitleAlignsWithTheChatAndIsLarger(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	title, ok := tester.Find("对话标题名")
	if !ok {
		t.Fatalf("the chat title row never rendered, texts %q", tester.Texts())
	}
	body, ok := tester.Find("来自主控")
	if !ok {
		t.Fatalf("the chat body never rendered, texts %q", tester.Texts())
	}
	if delta := title.X - body.X; delta < -1 || delta > 1 {
		t.Fatalf("the title starts at %v, the chat text at %v", title.X, body.X)
	}
	if title.H <= body.H {
		t.Fatalf("the title is not larger: %v against %v", title.H, body.H)
	}
}

func TestTheChatTitleStaysEmptyWhileTheConversationLoads(t *testing.T) {
	state := fourPaneShell(t)
	state.chat.active = ""
	tester := frames(ui.NewTester(state.view, 1440, 900))
	if title, ok := tester.Find("对话标题名"); ok {
		t.Fatalf("the loading title still shows something at %v, texts %q", title, tester.Texts())
	}
}

func TestTheTitleBandLinesUpWithTheTrafficLightsAndPadsTheCardEvenly(t *testing.T) {
	state := fourPaneShell(t)
	tester := ui.NewTester(state.view, 1440, 900)
	tester.SetTitleBar(ui.TitleBar{Height: 42, Left: 68})
	frames(tester)
	title, ok := tester.Find("对话标题")
	if !ok {
		t.Fatalf("the chat title row never rendered, texts %q", tester.Texts())
	}
	tab, ok := tester.Find("标签页 白板")
	if !ok {
		t.Fatalf("the whiteboard tab never rendered, texts %q", tester.Texts())
	}
	center := float32(21)
	if delta := (title.Y + title.H/2) - center; delta < -1 || delta > 1 {
		t.Fatalf("the chat title centers at %v, the traffic lights at %v", title.Y+title.H/2, center)
	}
	_ = tab
	card, ok := tester.Find("主区域卡片")
	if !ok {
		t.Fatalf("the card never rendered, texts %q", tester.Texts())
	}
	if card.Y != 42 {
		t.Fatalf("the card top sits at %v, not below the title band", card.Y)
	}
	if delta := (tab.Y + tab.H/2) - 21; delta < -1 || delta > 1 {
		t.Fatalf("the tab centers at %v, the header band at %v", tab.Y+tab.H/2, 21)
	}
	if delta := (title.Y + title.H/2) - 21; delta < -1 || delta > 1 {
		t.Fatalf("the title centers at %v, the header band at %v", title.Y+title.H/2, 21)
	}
}

func TestTheTrafficLightsUseTheCodexPosition(t *testing.T) {
	position := trafficLightPosition()
	if position.X != 16 || position.Y != 15 {
		t.Fatalf("the traffic lights sit at %+v", position)
	}
}

func TestTheFunctionRailCentersOnTheRedLightAndHasEvenGaps(t *testing.T) {
	state := fourPaneShell(t)
	tester := frames(ui.NewTester(state.view, 1440, 900))
	icon, ok := tester.Find("轨迹")
	if !ok {
		t.Fatalf("the rail never rendered, texts %q", tester.Texts())
	}
	redCenter := float32(trafficLightPosition().X) + 6.5
	if delta := (icon.X + icon.W/2) - redCenter; delta < -1 || delta > 1 {
		t.Fatalf("the rail centers at %v, the red light at %v", icon.X+icon.W/2, redCenter)
	}
	card, ok := tester.Find("主区域卡片")
	if !ok {
		t.Fatalf("the card never rendered, texts %q", tester.Texts())
	}
	left := icon.X
	right := card.X - (icon.X + icon.W)
	if delta := left - right; delta < -1 || delta > 1 {
		t.Fatalf("the rail leaves %v left and %v right", left, right)
	}
}
