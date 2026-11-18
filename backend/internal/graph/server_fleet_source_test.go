// graph:table-writes-exempt: a test seeds the rows the projection reads
package graph

import (
	"path/filepath"
	"strconv"
	"testing"
)

func TestTheFleetProjectsTheSenderOfACrossAgentMessage(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "fleet-source.sqlite"))
	t.Cleanup(store.Close)
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-1','p1','做一件事',1,'running','c-proj')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB.Exec(`INSERT INTO events(task_id,type,data,timestamp) VALUES('t-1','message.created',
		'{"message":{"id":"m1","role":"user","kind":"chat","text":"来自主控","data":{"source":{"conversationId":"c-global","kind":"agent","taskId":"t-global"}}}}',7000)`); err != nil {
		t.Fatal(err)
	}
	RegisterAgent(store, AgentRegistration{Id: "c-global", Kind: "global", Role: "global", Name: "Main", ConversationId: "c-global", TaskId: "t-global", Workspace: "/tmp/g", Model: "m", CreatedAt: 1})
	RegisterAgent(store, AgentRegistration{Id: "c-proj", ParentId: "c-global", Kind: "project", Role: "project", Name: "项目", ConversationId: "c-proj", TaskId: "t-1", ProjectId: "p1", Workspace: "/tmp/p1", Model: "m", CreatedAt: 2})
	view := fleetProjection(store, "")
	if len(view.Events) != 1 {
		t.Fatalf("one event is projected, got %+v", view.Events)
	}
	event := view.Events[0]
	if event.AgentId != "c-proj" || event.SenderAgentId != "c-global" {
		t.Fatalf("the message names its receiver and its sender, got %+v", event)
	}
	if event.Text != "来自主控" {
		t.Fatalf("the message keeps its text, got %+v", event)
	}
}

func TestTheFleetKeepsCrossAgentEventsOutOfTheRecentWindow(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.exec(t, `INSERT INTO events(task_id,type,data,timestamp) VALUES('t-work','message.created',
		'{"message":{"id":"m-old","role":"user","text":"很旧的一次委派","data":{"source":{"conversationId":"c-global","kind":"agent"}}}}',1)`)
	for index := 0; index < fleetEventLimit+40; index++ {
		fixture.exec(t, `INSERT INTO events(task_id,type,data,timestamp) VALUES('t-work','graph.tool.settled',?,?)`,
			`{"summary":"工具 `+strconv.Itoa(index)+`"}`, 9000+index)
	}
	view := fleetProjection(fixture.store, "c-global")
	sent := false
	for _, event := range view.Events {
		if event.SenderAgentId == "c-global" && event.AgentId == "c-proj" {
			sent = true
			break
		}
	}
	if !sent {
		t.Fatalf("the older cross-agent event survives the busy tool log, events %d", len(view.Events))
	}
}
