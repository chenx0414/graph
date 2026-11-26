package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

var assemblyFixtures = map[string]string{
	"/api/catalog": `{
		"definitions":[{"id":"coder","version":11},{"id":"reviewer","version":9}],
		"agentCombinations":[
			{"id":"coder","name":"Bob_coder","description":"通用代码实现 Agent：按规格实现功能。","review":false,"tags":["coding","implementation"],"resources":[
				{"resourceId":"gan","version":"1","role":"identity","required":true},
				{"resourceId":"missing-skill","version":"2","role":"skill","required":true}
			],"status":"invalid","issues":["Missing required capability missing-skill@2 (skill)"],"resolved":[
				{"resourceId":"gan","version":"1","role":"identity","required":true,"kind":"prompt","name":"gan-generator"}
			]},
			{"id":"main","name":"Atlas_main","description":"持续面对用户、规划任务。","mode":"main","review":false,"tags":["main"],"resources":[],"status":"valid","issues":[],"resolved":[]}
		],
		"capabilities":[
			{"id":"skill-helper","kind":"skill","version":"abc123","name":"helper","status":"available"},
			{"id":"prompt-helper","kind":"prompt","version":"def456","name":"helper-prompt","status":"available"}
		],
		"agentCombinationFile":"/Users/macmini/.graph/agent-combinations.json",
		"agentCombinationError":null
	}`,
}

func assemblyServer(t *testing.T, actions map[string]int, bodies *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost || r.Method == http.MethodDelete {
			payload := make([]byte, 8192)
			read, _ := r.Body.Read(payload)
			if bodies != nil {
				*bodies = append(*bodies, r.Method+" "+r.URL.Path+" "+string(payload[:read]))
			}
			if actions != nil {
				actions[r.Method+" "+r.URL.Path]++
			}
			switch {
			case strings.HasSuffix(r.URL.Path, "/compile"):
				w.Write([]byte(`{"combination":{"id":"coder","name":"Bob_coder","status":"valid","issues":[],"resolved":[]},"definitionId":"coder","definitionVersion":"coder@12","version":12}`))
			case strings.HasSuffix(r.URL.Path, "/description"):
				w.Write([]byte(`{"combination":{"id":"coder","name":"Bob_coder","description":"新的描述","status":"valid","issues":[],"resolved":[]},"definition":{"definitionId":"coder","definitionVersion":"coder@13"}}`))
			case r.Method == http.MethodDelete:
				w.Write([]byte(`{"id":"coder","deleted":true}`))
			default:
				w.Write([]byte(`{"combination":{"id":"coder-copy","name":"Bob_coder 副本","description":"通用代码实现 Agent：按规格实现功能。","status":"valid","issues":[],"resolved":[]},"definition":{"definitionId":"coder-copy","definitionVersion":"coder-copy@1"}}`))
			}
			return
		}
		body, ok := assemblyFixtures[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(body))
	}))
}

func assemblyTester(state *assemblyState) *ui.Tester {
	tester := newTester(state.view, 1100, 820)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}
	return tester
}

func TestTheAssemblyPageListsEveryRecipeWithItsStatus(t *testing.T) {
	server := assemblyServer(t, nil, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	tester := assemblyTester(state)
	for _, want := range []string{"能力装配", "Bob_coder", "Atlas_main", "通用代码实现 Agent", "主 Agent",
		"有问题", "可用", "coder@11", "2 个资源", "agent-combinations.json"} {
		if !tester.HasText(want) {
			t.Fatalf("装配列表缺 %q，texts %q", want, tester.Texts())
		}
	}
}

func TestTheAssemblyDetailShowsResourcesIssuesAndDefinition(t *testing.T) {
	server := assemblyServer(t, nil, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	tester := assemblyTester(state)
	for _, want := range []string{"Bob_coder", "coder", "gan-generator", "gan@1", "missing-skill@2", "缺少",
		"Missing required capability missing-skill@2 (skill)", "编译", "删除", "改描述", "打开装配文件"} {
		if !tester.HasText(want) {
			t.Fatalf("装配详情缺 %q，texts %q", want, tester.Texts())
		}
	}
}

func TestCompilingAnAssemblyShowsTheNewDefinitionVersion(t *testing.T) {
	actions := map[string]int{}
	server := assemblyServer(t, actions, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	tester := assemblyTester(state)
	if err := tester.Click("编译"); err != nil {
		t.Fatalf("click compile: %v", err)
	}
	deadline := 0
	for actions["POST /api/catalog/combinations/coder/compile"] == 0 && deadline < 500 {
		tester.Frame()
		deadline++
	}
	if actions["POST /api/catalog/combinations/coder/compile"] != 1 {
		t.Fatalf("编译打一次 compile 接口，actions %v (%q)", actions, state.status)
	}
	tester = assemblyTester(state)
	if !tester.HasText("coder@12") {
		t.Fatalf("编译后显示新的 definitionVersion，texts %q", tester.Texts())
	}
}

func TestSavingADescriptionUpdatesTheRecipe(t *testing.T) {
	bodies := []string{}
	server := assemblyServer(t, nil, &bodies)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	state.draftDescription = "新的描述"
	state.saveDescription()

	if len(bodies) != 1 || !strings.Contains(bodies[0], "POST /api/catalog/combinations/coder/description") {
		t.Fatalf("改描述打 description 接口，bodies %v (%q)", bodies, state.status)
	}
	if !strings.Contains(bodies[0], `"description":"新的描述"`) {
		t.Fatalf("提交体带新描述，body %q", bodies[0])
	}
	if state.status != "" {
		t.Fatalf("成功后清空状态，got %q", state.status)
	}
}

func TestAnEmptyDescriptionIsRefusedBeforeAnyWrite(t *testing.T) {
	bodies := []string{}
	server := assemblyServer(t, nil, &bodies)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	state.draftDescription = "   "
	state.saveDescription()
	if len(bodies) != 0 {
		t.Fatalf("空描述不发请求，bodies %v", bodies)
	}
	if state.status == "" {
		t.Fatal("空描述要说清为什么没保存")
	}
}

func TestDeletingAnAssemblyAsksThenRemovesIt(t *testing.T) {
	actions := map[string]int{}
	server := assemblyServer(t, actions, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	state.deleteAssembly("coder")
	if state.deleteArmed != "coder" {
		t.Fatalf("第一次删除只武装，armed %q (%q)", state.deleteArmed, state.status)
	}
	state.deleteAssembly("coder")
	deadline := 0
	for actions["DELETE /api/catalog/combinations/coder"] == 0 && deadline < 500 {
		deadline++
	}
	if actions["DELETE /api/catalog/combinations/coder"] != 1 {
		t.Fatalf("第二次删除打 DELETE，actions %v (%q)", actions, state.status)
	}
	if state.selected != "" {
		t.Fatalf("删除后退出详情，selected %q", state.selected)
	}
}

func TestTheMainRecipeCannotBeDeleted(t *testing.T) {
	state := newAssemblyState("http://127.0.0.1:1", "tok")
	state.rows = []assemblyRow{{id: "main", name: "Atlas_main", mode: "main", status: "valid"}}
	state.selectAssembly("main")
	state.deleteAssembly("main")
	if state.deleteArmed != "" {
		t.Fatalf("主装配不能删除，armed %q", state.deleteArmed)
	}
	if state.status == "" {
		t.Fatal("主装配删除要说明原因")
	}
}

func TestDuplicatingAnAssemblyPrefillsTheEditorWithItsResources(t *testing.T) {
	bodies := []string{}
	server := assemblyServer(t, nil, &bodies)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.duplicateAssembly("coder")
	if !state.editorOpen {
		t.Fatal("复制打开编辑器")
	}
	if state.editorID != "coder-copy" || !strings.Contains(state.editorName, "副本") {
		t.Fatalf("编辑器预填 id/name，id %q name %q", state.editorID, state.editorName)
	}
	state.createAssembly()
	if len(bodies) != 1 || !strings.Contains(bodies[0], "POST /api/catalog/combinations ") {
		t.Fatalf("新建打 combinations 接口，bodies %v (%q)", bodies, state.status)
	}
	for _, want := range []string{`"id":"coder-copy"`, `"resourceId":"gan"`, `"resourceId":"missing-skill"`} {
		if !strings.Contains(bodies[0], want) {
			t.Fatalf("新建带上 %q，body %q", want, bodies[0])
		}
	}
}

func TestTheAssemblyFileAndErrorAreShown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"definitions":[],"agentCombinations":[],"agentCombinationFile":"/Users/macmini/.graph/agent-combinations.json","agentCombinationError":"combinations[0].id is invalid"}`))
	}))
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	tester := assemblyTester(state)
	if !tester.HasText("agent-combinations.json") || !tester.HasText("combinations[0].id is invalid") {
		t.Fatalf("装配文件与错误要显示，texts %q", tester.Texts())
	}
	if !tester.HasText("还没有装配") {
		t.Fatalf("空列表要有空态，texts %q", tester.Texts())
	}
}

func TestTheAssemblyModulePageCarriesItsTitle(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "tok")
	state.openModule("assemblies")
	if title := boardPanelTitle("assemblies"); title != "能力装配" {
		t.Fatalf("装配页标题是能力装配，got %q", title)
	}
	if state.activeBoardKind() != "assemblies" {
		t.Fatalf("打开后停在装配页，kind %q", state.activeBoardKind())
	}
}

func TestTheDescriptionIsReadOnlyUntilItIsEdited(t *testing.T) {
	server := assemblyServer(t, nil, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	tester := assemblyTester(state)
	if !tester.HasText("改描述") || !tester.HasText("通用代码实现 Agent：按规格实现功能。") {
		t.Fatalf("描述先只读地展示，texts %q", tester.Texts())
	}
	if err := tester.Click("改描述"); err != nil {
		t.Fatalf("click 改描述: %v", err)
	}
	frames(tester)
	if !state.editingDescription {
		t.Fatal("点改描述进入编辑")
	}
	if !tester.HasText("保存描述") || !tester.HasText("取消") {
		t.Fatalf("编辑态给出保存与取消，texts %q", tester.Texts())
	}
	state.editingDescription = false
	state.frame()
}

func TestAddingAResourceSavesTheWholeRecipe(t *testing.T) {
	actions := map[string]int{}
	bodies := []string{}
	server := assemblyServer(t, actions, &bodies)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	tester := assemblyTester(state)
	if err := tester.Click("添加资源"); err != nil {
		t.Fatalf("open the resource picker: %v", err)
	}
	tester = frames(tester)
	if err := tester.Click("添加 skill-helper"); err != nil {
		t.Fatalf("pick a capability: %v", err)
	}
	for frame := 0; frame < 50 && actions["POST /api/catalog/combinations"] == 0; frame++ {
		tester.Frame()
	}
	if actions["POST /api/catalog/combinations"] != 1 {
		t.Fatalf("adding a resource saves the recipe, actions %v (%q)", actions, state.status)
	}
	body := bodies[0]
	for _, want := range []string{`"id":"coder"`, `"name":"Bob_coder"`, `"resourceId":"gan"`, `"resourceId":"skill-helper"`, `"role":"skill"`, `"version":"abc123"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("the saved recipe carries %s, body %s", want, body)
		}
	}
}

func TestRemovingAResourceSavesTheWholeRecipeWithoutIt(t *testing.T) {
	actions := map[string]int{}
	bodies := []string{}
	server := assemblyServer(t, actions, &bodies)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	tester := assemblyTester(state)
	if err := tester.Click("移除 gan"); err != nil {
		t.Fatalf("remove a resource: %v", err)
	}
	for frame := 0; frame < 50 && actions["POST /api/catalog/combinations"] == 0; frame++ {
		tester.Frame()
	}
	if actions["POST /api/catalog/combinations"] != 1 {
		t.Fatalf("removing a resource saves the recipe, actions %v (%q)", actions, state.status)
	}
	body := bodies[0]
	if strings.Contains(body, `"resourceId":"gan"`) {
		t.Fatalf("the saved recipe drops the removed resource, body %s", body)
	}
	if !strings.Contains(body, `"resourceId":"missing-skill"`) {
		t.Fatalf("the saved recipe keeps the rest, body %s", body)
	}
}

func TestTheResourcePickerHidesASecondIdentityPrompt(t *testing.T) {
	server := assemblyServer(t, nil, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.load()
	state.selectAssembly("coder")
	tester := assemblyTester(state)
	if err := tester.Click("添加资源"); err != nil {
		t.Fatalf("open the resource picker: %v", err)
	}
	tester = frames(tester)
	if tester.HasText("添加 prompt-helper") {
		t.Fatalf("the picker hides another identity prompt, texts %q", tester.Texts())
	}
	if !tester.HasText("添加 skill-helper") {
		t.Fatalf("the picker keeps a skill, texts %q", tester.Texts())
	}
}
