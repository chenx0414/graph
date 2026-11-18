package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestADefinitionVersionNamesItsAssembly(t *testing.T) {
	cases := map[string]string{
		"coder@10":   "coder",
		"reviewer@8": "reviewer",
		"main@23":    "main",
		"graph@1":    "graph",
		"":           "",
		"no-version": "no-version",
		"a@b@c":      "a",
	}
	for input, want := range cases {
		if got := definitionAssemblyID(input); got != want {
			t.Fatalf("definitionAssemblyID(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTheAgentPanelLinksADefinitionToItsAssembly(t *testing.T) {
	fleet := ringGraphFleet()
	node := fleetAgent{ID: "p1-n2", ParentID: "p1", Kind: "node", Name: "fleet-ui", TaskID: "tA", NodeID: "n2", Status: "running"}
	mock := &nodeChatMock{
		fleet: fleet,
		run:   `{"entries":[{"seq":1,"id":"e1","role":"assistant","kind":"message","text":"正在改装配页","createdAt":1}]}`,
		taskView: `{"id":"tA","request":"做点事","status":"running","phase":"executing","nodes":[
			{"id":"n2","role":"coder","kind":"agent","status":"running","model":"deepseek-v4-flash","definitionVersion":"coder@10"}]}`,
	}
	state, tester := nodeChatShell(t, mock)
	state.assemblies = &assemblyState{rows: []assemblyRow{
		{id: "coder", name: "Bob_coder", description: "通用代码实现", status: "valid", mode: "", resources: []assemblyResource{{ResourceID: "gan", Version: "1", Role: "identity"}}},
	}}
	state.openFleetAgentChat(node)
	tester = frames(tester)
	if !tester.HasText("装配 coder") {
		t.Fatalf("the node row links its definition, texts %q", tester.Texts())
	}
	boardReveal(t, tester, state, "装配 coder")
	if err := tester.Click("装配 coder"); err != nil {
		t.Fatalf("click the definition: %v", err)
	}
	tester = frames(tester)
	if state.activeBoardKind() != "assemblies" {
		t.Fatalf("the definition opens the assembly page, kind %q", state.activeBoardKind())
	}
	if state.assemblies == nil || state.assemblies.selected != "coder" {
		t.Fatalf("the assembly detail opens for coder, got %+v", state.assemblies)
	}
	if !tester.HasText("Bob_coder") {
		t.Fatalf("the assembly detail renders, texts %q", tester.Texts())
	}
}

func TestADefinitionWithoutAnAssemblySaysSo(t *testing.T) {
	state := newShellState("http://127.0.0.1:1", "tok")
	state.assemblies = &assemblyState{rows: []assemblyRow{{id: "coder", name: "Bob_coder"}}}
	state.openAssemblyDefinition("ghost@3")
	if state.activeBoardKind() != "assemblies" {
		t.Fatalf("the page opens anyway, kind %q", state.activeBoardKind())
	}
	if state.assemblies.selected != "" {
		t.Fatalf("nothing is selected for an unknown definition, got %q", state.assemblies.selected)
	}
	if state.assemblies.status == "" {
		t.Fatal("an unknown definition explains itself")
	}
}

func TestAPendingSelectionAppliesAfterTheAssembliesLoad(t *testing.T) {
	server := assemblyServer(t, nil, nil)
	defer server.Close()

	state := newAssemblyState(server.URL, "tok")
	state.focusDefinition("coder@11")
	state.load()
	if state.selected != "coder" {
		t.Fatalf("the pending definition selects its assembly after load, selected %q (%q)", state.selected, state.status)
	}
	if state.pendingSelect != "" {
		t.Fatalf("the pending selection clears, got %q", state.pendingSelect)
	}
}

func TestTheGraphNodeCardCarriesItsBoundDefinition(t *testing.T) {
	mock := &fleetGraphMock{topology: fleetTopologySample, fleet: ringGraphFleet()}
	state, tester := fleetGraphTester(t, mock, ringGraphFleet())
	state.assemblies = &assemblyState{rows: []assemblyRow{{id: "research", name: "Researcher", status: "valid"}}}
	tester = frames(tester)
	if !tester.HasText("装配 research") {
		t.Fatalf("the graph card links its bound definition, texts %q", tester.Texts())
	}
	if err := tester.Click("装配 research"); err != nil {
		t.Fatalf("click the graph definition: %v", err)
	}
	frames(tester)
	if state.activeBoardKind() != "assemblies" {
		t.Fatalf("the graph definition opens the assembly page, kind %q", state.activeBoardKind())
	}
}

func TestTheCatalogLinkEndpointIsNotNeededForAnAssemblyWeAlreadyHave(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	state := newShellState(server.URL, "tok")
	state.assemblies = &assemblyState{rows: []assemblyRow{{id: "coder", name: "Bob_coder"}}}
	state.openAssemblyDefinition("coder@10")
	if state.assemblies.selected != "coder" {
		t.Fatalf("a loaded assembly selects without another fetch, selected %q", state.assemblies.selected)
	}
}

var _ = ui.Rect{}

func TestSelectingAnAssemblyClearsTheMissingDefinitionNotice(t *testing.T) {
	state := newAssemblyState("http://127.0.0.1:1", "tok")
	state.rows = []assemblyRow{{id: "coder", name: "Bob_coder"}, {id: "reviewer", name: "Alice_reviewer"}}
	state.focusDefinition("ghost@3")
	if state.status == "" {
		t.Fatal("the missing definition notice shows first")
	}
	state.selectAssembly("coder")
	if state.status != "" {
		t.Fatalf("picking an assembly clears the notice, status %q", state.status)
	}
	if state.selected != "coder" {
		t.Fatalf("the picked assembly is selected, got %q", state.selected)
	}
}
