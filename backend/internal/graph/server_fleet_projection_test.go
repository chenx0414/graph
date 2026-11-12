// graph:table-writes-exempt: a test seeds the rows the projection reads
package graph

import (
	"encoding/json"
	"math"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestFleetJSONKeysMatchTheClientContract(t *testing.T) {
	fixture := seedFleetFixture(t)
	recorder := fixture.get(t, "")
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"rootId", "agents", "links", "stats", "tasks", "events", "artifacts", "truncated"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("the payload has no %q: %v", key, raw)
		}
	}
	agent := raw["agents"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "parentId", "kind", "role", "name", "model", "projectId", "conversationId",
		"taskId", "nodeId", "status", "activity", "tokens", "cost", "requests", "messages", "createdAt",
		"updatedAt", "currentOperationId"} {
		if _, ok := agent[key]; !ok {
			t.Fatalf("agent has no %q: %v", key, agent)
		}
	}
	event := raw["events"].([]any)[0].(map[string]any)
	for _, key := range []string{"id", "at", "type", "agentId", "targetAgentId", "taskId", "text"} {
		if _, ok := event[key]; !ok {
			t.Fatalf("event has no %q: %v", key, event)
		}
	}
	if raw["links"].([]any)[0].(map[string]any)["kind"] != "parent" {
		t.Fatalf("links must be parent links: %v", raw["links"])
	}
}

func TestFleetProjectScopeProjectsTheProjectSubtree(t *testing.T) {
	fixture := seedFleetFixture(t)
	view := fixture.fleet(t, "c-proj")
	if view.RootId != "c-proj" {
		t.Fatalf("rootId is %q", view.RootId)
	}
	ids := fleetIDs(view.Agents)
	want := []string{"c-proj", "t-work/n1", "t-work/n2", "t-work/n4"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("project agents are %v, want %v", ids, want)
	}
	if len(view.Links) != 3 {
		t.Fatalf("project links are %+v", view.Links)
	}
	for _, link := range view.Links {
		if link.From != "c-proj" {
			t.Fatalf("a project fleet must not link to an outside parent: %+v", view.Links)
		}
	}
	if got := view.Stats; got.Agents != 4 || got.Running != 1 || got.Tasks != 2 || got.Messages != 4 ||
		got.Tokens != 148 || math.Abs(got.Cost-0.8) > 1e-9 {
		t.Fatalf("project stats are %+v", got)
	}
	taskIDs := []string{}
	for _, task := range view.Tasks {
		taskIDs = append(taskIDs, task.Id)
	}
	if !reflect.DeepEqual(taskIDs, []string{"t-work", "w1"}) {
		t.Fatalf("project tasks are %v", taskIDs)
	}
	if len(view.Events) != 4 {
		t.Fatalf("project events are %+v", view.Events)
	}
	for _, event := range view.Events {
		if event.TaskId == "t-global" {
			t.Fatalf("the global conversation event leaked into the project scope: %+v", event)
		}
	}
	if len(view.Artifacts) != 1 || view.Artifacts[0].ArtifactId != "a1" {
		t.Fatalf("project artifacts are %+v", view.Artifacts)
	}
}

func TestFleetRejectsUnknownAndChatConversations(t *testing.T) {
	fixture := seedFleetFixture(t)
	for _, conversationId := range []string{"missing", "c-chat"} {
		recorder := fixture.get(t, conversationId)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s -> %d %s", conversationId, recorder.Code, recorder.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode error: %v", err)
		}
		code := body["code"]
		if conversationId == "missing" && code != "not_found" {
			t.Fatalf("missing conversation code is %v", code)
		}
		if conversationId == "c-chat" && code != "invalid_input" {
			t.Fatalf("chat conversation code is %v", code)
		}
	}
}

func TestFleetTruncatesEventsAndArtifactsAtTwoHundred(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.store.Transaction(func() any {
		for index := 0; index < 205; index++ {
			fixture.exec(t, `INSERT INTO events(task_id,type,data,timestamp) VALUES('t-work','node.entry','{"nodeId":"n4"}',?)`, 7000+index)
			fixture.exec(t, `INSERT INTO artifacts(artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,
				logical_key,digest,object_path,size,media_type,title,producer_node_id,producer_instance_id,visibility,trust,
				state,metadata,created_at) VALUES(?,'1','task','t-work','t-work','p1','shared',?,
				?,'sha','/tmp/x',1,'text/plain','', 'n4','i-n4','task','trusted','published','{}',?)`,
				"bulk-"+itoa(index), "bulk-"+itoa(index)+".txt", "shared/bulk-"+itoa(index)+".txt", 7000+index)
		}
		return nil
	})
	view := fixture.fleet(t, "")
	if !view.Truncated {
		t.Fatal("more than 200 events and artifacts must set truncated")
	}
	if len(view.Events) != 200 || len(view.Artifacts) != 200 {
		t.Fatalf("events %d artifacts %d, want 200 each", len(view.Events), len(view.Artifacts))
	}
	if view.Stats.Agents != 6 || view.Stats.Tasks != 3 {
		t.Fatalf("truncation must keep full stats: %+v", view.Stats)
	}
}

func TestFleetTruncatesAgentsBeyondOneThousandAndKeepsFullStats(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.store.Transaction(func() any {
		for index := 0; index < 1001; index++ {
			RegisterAgent(fixture.store, AgentRegistration{
				Id: "child-" + itoa(index), ParentId: "c-global", Kind: "child", Role: "worker",
			})
		}
		return nil
	})
	view := fixture.fleet(t, "")
	if len(view.Agents) != 1000 {
		t.Fatalf("the payload carried %d agents", len(view.Agents))
	}
	if !view.Truncated || view.Stats.Agents != 1007 {
		t.Fatalf("agents truncation is %v with stats %+v", view.Truncated, view.Stats)
	}
	if view.Agents[0].Id != "c-global" {
		t.Fatalf("the root agent must survive truncation: %+v", view.Agents[0])
	}
	kept := map[string]bool{}
	for _, agent := range view.Agents {
		kept[agent.Id] = true
	}
	for _, link := range view.Links {
		if !kept[link.From] || !kept[link.To] {
			t.Fatalf("truncation left a dangling link: %+v", link)
		}
	}
}

func TestFleetWithoutGlobalConversationKeepsEveryRootWithoutCrashing(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.exec(t, `DELETE FROM messages WHERE conversation_id='c-global'`)
	fixture.exec(t, `DELETE FROM conversations WHERE id='c-global'`)
	view := fixture.fleet(t, "")
	if view.RootId != "" {
		t.Fatalf("rootId should stay empty without a global conversation, got %q", view.RootId)
	}
	ids := fleetIDs(view.Agents)
	want := []string{"c-global", "c-proj", "t-old/n3", "t-work/n1", "t-work/n2", "t-work/n4", "orphan-child"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("every root must survive the missing global conversation: %v", ids)
	}
	if len(view.Links) != 5 {
		t.Fatalf("links are %+v", view.Links)
	}
	if fleetAgent(t, view, "orphan-child").ParentId != "" {
		t.Fatalf("an orphan must keep an empty parent: %+v", view.Links)
	}
}

func TestFleetReadsTheCurrentSupervisorModelFromTheLedger(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.exec(t, `UPDATE nodes SET spec='{"role":"master","action":"supervise","model":"m-switched"}'
		WHERE task_id='t-global' AND id='master'`)
	view := fixture.fleet(t, "")
	if model := fleetAgent(t, view, "c-global").Model; model != "m-switched" {
		t.Fatalf("the projection must follow the current ledger model, got %q", model)
	}
	if record := AgentById(fixture.store, "c-global"); record.Model != "m-super" {
		t.Fatalf("the projection must not rewrite the registered model: %+v", record)
	}
}

func TestFleetTrimKeepsThePayloadUnderTwoMegabytes(t *testing.T) {
	text := strings.Repeat("x", 600*1024)
	view := FleetView{
		RootId: "c-global",
		Agents: []FleetAgent{{Id: "c-global", Kind: "global", Status: "idle"}},
		Events: []FleetEvent{
			{Id: "4", Type: "node.entry", Text: text}, {Id: "3", Type: "node.entry", Text: text},
			{Id: "2", Type: "node.entry", Text: text}, {Id: "1", Type: "node.entry", Text: text},
		},
	}
	body := fleetTrim(view)
	if len(body) > fleetPayloadLimit {
		t.Fatalf("the trimmed payload is %d bytes", len(body))
	}
	var trimmed FleetView
	if err := json.Unmarshal(body, &trimmed); err != nil {
		t.Fatalf("decode trimmed payload: %v", err)
	}
	if !trimmed.Truncated || len(trimmed.Events) != 2 {
		t.Fatalf("trimming kept %d events (truncated=%v)", len(trimmed.Events), trimmed.Truncated)
	}
	if trimmed.Stats.Agents != view.Stats.Agents {
		t.Fatalf("trimming must keep stats: %+v", trimmed.Stats)
	}
}

func TestFleetProjectionDoesNotWriteAgentRuntimeState(t *testing.T) {
	fixture := seedFleetFixture(t)
	before := kernelRows(fixture.store.DB, "SELECT * FROM agents ORDER BY id")
	fixture.fleet(t, "")
	fixture.fleet(t, "c-proj")
	after := kernelRows(fixture.store.DB, "SELECT * FROM agents ORDER BY id")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("the projection rewrote agents:\nbefore %v\nafter %v", before, after)
	}
}
