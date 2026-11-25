package graph

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"testing"
)

type fleetFixture struct {
	store  *TaskStore
	kernel *KernelStore
	app    *GraphApp
}

func (fixture *fleetFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := fixture.store.DB.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func execInTransaction(t *testing.T, tx *TaskStore, query string, args ...any) {
	t.Helper()
	if _, err := tx.DB.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func seedFleetFixture(t *testing.T) *fleetFixture {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "fleet.sqlite"))
	kernel := NewKernelStore(store)
	t.Cleanup(store.Close)
	fixture := &fleetFixture{store: store, kernel: kernel}
	tasks := []string{
		`INSERT INTO projects(id,root,grants) VALUES('global-workspace','/tmp/global','[]')`,
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-global','global-workspace','Main',1,'chatting','c-global')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-proj','p1','Project',2,'chatting','c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-work','p1','实现编队页',3,'running','c-proj')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t-old','p1','旧任务',4,'abandoned')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-chat','p1','chat',5,'chatting','c-chat')`,
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
			VALUES('c-global',NULL,'global-workspace','t-global','Main',1,1000,'global')`,
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
			VALUES('c-proj','p1','p1','t-proj','项目一',2,1100,'project')`,
		`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
			VALUES('c-chat',NULL,'p1','t-chat','聊天',3,1200)`,
		`INSERT INTO nodes(task_id,id,spec) VALUES('t-global','master','{"role":"master","action":"supervise"}')`,
		`INSERT INTO nodes(task_id,id,spec) VALUES('t-proj','master','{"role":"master","action":"supervise"}')`,
		`INSERT INTO nodes(task_id,id,spec,instance_id,status)
			VALUES('t-work','n1','{"role":"implementer","model":"m-legacy","action":"implement"}','i-n1','succeeded')`,
		`INSERT INTO nodes(task_id,id,spec,instance_id,status)
			VALUES('t-work','n2','{"role":"reviewer","action":"review"}','i-n2','blocked')`,
		`INSERT INTO nodes(task_id,id,spec,instance_id,status)
			VALUES('t-old','n3','{"role":"worker","action":"clean"}','i-n3','failed')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i-global','t-global','master','m-super')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i-proj','t-proj','master','m-super')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i-n1','t-work','n1','m-legacy')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i-n2','t-work','n2','m-review')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i-n3','t-old','n3','m-clean')`,
		`INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status)
			VALUES('t-work',1,'n4','i-n4','agent','{"model":"m-kernel"}','idle')`,
		`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
			VALUES('o-global','t-global','master','i-global',1,'{"action":"supervise"}','dispatched',100,1)`,
		`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
			VALUES('o-proj','t-proj','master','i-proj',1,'{"action":"supervise"}','succeeded',100,0)`,
		`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
			VALUES('o-n1','t-work','n1','i-n1',1,'{"action":"implement"}','succeeded',100,0)`,
		`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
			VALUES('o-n2','t-work','n2','i-n2',1,'{"action":"review"}','dispatched',100,0)`,
		`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
			VALUES('o-n3','t-old','n3','i-n3',1,'{"action":"clean"}','failed',100,0)`,
		`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
			VALUES('inv-global','o-global','i-global','m-super','{"input":100,"output":50,"cacheRead":10,"cacheWrite":5}','{"amount":0.5}','completion',4000,5000)`,
		`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
			VALUES('inv-proj','o-proj','i-proj','m-super','{"input":20,"output":10}','{"amount":0.25}','completion',5100,5150)`,
		`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
			VALUES('inv-n1','o-n1','i-n1','m-legacy','{"input":30,"output":20}','{"amount":0.1}','completion',2900,3000)`,
		`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
			VALUES('inv-n2','o-n2','i-n2','m-review','{"input":10,"output":5}','{"amount":0.05}','completion',3020,3100)`,
		`INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
			VALUES('inv-n3','o-n3','i-n3','m-clean','{"input":7,"output":3}','{"amount":0.02}','completion',2000,2100)`,
		`INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,usage,cost,model,purpose,created_at,settled_at)
			VALUES('kpc-1','t-work','n4','e1',100,'settled','{"input":40,"output":10,"cacheRead":2,"cacheWrite":1}','{"amount":0.4}','m-kernel','completion',5100,5200)`,
		`INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at)
			VALUES('e1','t-work','n4',1,1,'running',5000)`,
		`INSERT INTO messages(id,conversation_id,role,kind,text,state,created_at,updated_at)
			VALUES('msg-1','c-global','user','chat','hi','done',1000,1000)`,
		`INSERT INTO messages(id,conversation_id,role,kind,text,state,created_at,updated_at)
			VALUES('msg-2','c-global','assistant','chat','hello','done',1500,2000)`,
		`INSERT INTO messages(id,conversation_id,role,kind,text,state,created_at,updated_at)
			VALUES('msg-3','c-proj','user','chat','做编队','done',1100,1100)`,
		`INSERT INTO node_entries(id,task_id,node_id,role,kind,text,created_at)
			VALUES('entry-1','t-work','n4','assistant','message','a',5000)`,
		`INSERT INTO node_entries(id,task_id,node_id,role,kind,text,created_at)
			VALUES('entry-2','t-work','n4','assistant','message','b',5100)`,
		`INSERT INTO node_entries(id,task_id,node_id,role,kind,text,created_at)
			VALUES('entry-3','t-work','n1','assistant','message','c',2000)`,
		`INSERT INTO work_requests(id,conversation_id,project_id,source_message_id,revision,state,created_at,updated_at)
			VALUES('w1','c-proj','p1','msg-3',1,'ready',1200,1300)`,
		`INSERT INTO work_request_revisions(work_id,revision,brief,project_id,acceptance,created_at)
			VALUES('w1',1,'编队页
细节','p1','[]',1200)`,
		`INSERT INTO events(task_id,type,data,timestamp)
			VALUES('t-work','work.graph.confirmed','{"workId":"w1","graphId":"t-work"}',5000)`,
		`INSERT INTO events(task_id,type,data,timestamp)
			VALUES('t-work','graph.node.started','{"nodeId":"n4"}',6000)`,
		`INSERT INTO events(task_id,type,data,timestamp)
			VALUES('t-proj','work.created','{"workId":"w1","projectId":"p1"}',1300)`,
		`INSERT INTO events(task_id,type,data,timestamp)
			VALUES('t-proj','work.delegated','{"workId":"w1","sourceConversationId":"c-global"}',1350)`,
		`INSERT INTO events(task_id,type,data,timestamp)
			VALUES('t-global','conversation.created','{"conversationId":"c-global","role":"global"}',1000)`,
		`INSERT INTO artifacts(artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,
			object_path,size,media_type,title,producer_node_id,producer_instance_id,visibility,trust,state,metadata,created_at)
			VALUES('a1',1,'task','t-work','t-work','p1','shared','fleet.json','shared/fleet.json','sha-a1',
			'/tmp/a1',100,'application/json','编队数据','n4','i-n4','task','trusted','published','{}',5100)`,
		`INSERT INTO artifacts(artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,
			object_path,size,media_type,title,producer_node_id,producer_instance_id,visibility,trust,state,metadata,created_at)
			VALUES('a2',1,'task','t-old','t-old','p1','shared','old.txt','shared/old.txt','sha-a2',
			'/tmp/a2',10,'text/plain','旧产物','n3','i-n3','task','trusted','published','{}',2000)`,
	}
	for _, query := range tasks {
		fixture.exec(t, query)
	}
	RegisterAgent(store, AgentRegistration{Id: "c-global", Kind: "global", Role: "global", Name: "Main",
		ConversationId: "c-global", TaskId: "t-global", Workspace: "/tmp/global", Model: "m-super", CreatedAt: 1000})
	RegisterAgent(store, AgentRegistration{Id: "c-proj", ParentId: "c-global", Kind: "project", Role: "project",
		Name: "项目一", ConversationId: "c-proj", TaskId: "t-proj", ProjectId: "p1", Workspace: "/tmp/p1",
		Model: "m-super", CreatedAt: 1100})
	RegisterNodeAgent(store, "t-work", "n1", "implementer", "p1")
	RegisterNodeAgent(store, "t-work", "n2", "reviewer", "p1")
	RegisterNodeAgent(store, "t-old", "n3", "worker", "p1")
	RegisterNodeAgent(store, "t-work", "n4", "worker", "p1")
	RegisterAgent(store, AgentRegistration{Id: "orphan-child", Kind: "child", Role: "worker", Name: "orphan"})
	fixture.app = CreateApp(&TaskRuntime{store: store, kernel: kernel}, AppOptions{})
	return fixture
}

func (fixture *fleetFixture) get(t *testing.T, conversationId string) *httptest.ResponseRecorder {
	t.Helper()
	target := "/api/fleet"
	if conversationId != "" {
		target += "?conversationId=" + url.QueryEscape(conversationId)
	}
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: fixture.app.session})
	recorder := httptest.NewRecorder()
	fixture.app.ServeHTTP(recorder, request)
	return recorder
}

func (fixture *fleetFixture) fleet(t *testing.T, conversationId string) FleetView {
	t.Helper()
	recorder := fixture.get(t, conversationId)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET /api/fleet?conversationId=%s -> %d %s", conversationId, recorder.Code, recorder.Body.String())
	}
	var view FleetView
	if err := json.Unmarshal(recorder.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode fleet view: %v", err)
	}
	return view
}

func fleetAgent(t *testing.T, view FleetView, id string) FleetAgent {
	t.Helper()
	for _, agent := range view.Agents {
		if agent.Id == id {
			return agent
		}
	}
	t.Fatalf("agent %s is missing from %+v", id, view.Agents)
	return FleetAgent{}
}

func fleetIDs(agents []FleetAgent) []string {
	ids := make([]string, 0, len(agents))
	for _, agent := range agents {
		ids = append(ids, agent.Id)
	}
	return ids
}

func TestFleetGlobalScopeProjectsTheWholeTree(t *testing.T) {
	fixture := seedFleetFixture(t)
	view := fixture.fleet(t, "")
	if view.RootId != "c-global" {
		t.Fatalf("rootId is %q", view.RootId)
	}
	if view.Truncated {
		t.Fatal("a small tree must not be truncated")
	}
	ids := fleetIDs(view.Agents)
	want := []string{"c-global", "c-proj", "t-old/n3", "t-work/n1", "t-work/n2", "t-work/n4"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("agents are %v, want %v", ids, want)
	}
	global := fleetAgent(t, view, "c-global")
	if global.Kind != "global" || global.ParentId != "" || global.Status != "running" {
		t.Fatalf("global agent is %+v", global)
	}
	if global.CurrentOperationId != "o-global" || global.Activity != "supervise" {
		t.Fatalf("global agent current work is %+v", global)
	}
	if global.Tokens != 165 || math.Abs(global.Cost-0.5) > 1e-9 || global.Requests != 1 || global.Messages != 2 {
		t.Fatalf("global agent usage is %+v", global)
	}
	if global.CreatedAt != 1000 || global.UpdatedAt != 5000 {
		t.Fatalf("global agent times are %+v", global)
	}
	project := fleetAgent(t, view, "c-proj")
	if project.ParentId != "c-global" || project.Status != "idle" || project.Messages != 1 || project.Tokens != 30 {
		t.Fatalf("project agent is %+v", project)
	}
	if project.UpdatedAt != 5150 || project.ProjectId != "p1" || project.Name != "项目一" {
		t.Fatalf("project agent identity/times are %+v", project)
	}
	n1 := fleetAgent(t, view, "t-work/n1")
	if n1.Status != "done" || n1.Messages != 1 || n1.Requests != 1 || n1.Tokens != 50 || n1.Model != "m-legacy" {
		t.Fatalf("succeeded node agent is %+v", n1)
	}
	if n1.ParentId != "c-proj" || n1.TaskId != "t-work" || n1.NodeId != "n1" || n1.Role != "implementer" {
		t.Fatalf("node agent identity is %+v", n1)
	}
	if n1.UpdatedAt != 3000 {
		t.Fatalf("node agent updatedAt is %+v", n1)
	}
	if blocked := fleetAgent(t, view, "t-work/n2"); blocked.Status != "blocked" {
		t.Fatalf("blocked node is %+v", blocked)
	}
	if failed := fleetAgent(t, view, "t-old/n3"); failed.Status != "failed" || failed.ParentId != "c-global" {
		t.Fatalf("failed node is %+v", failed)
	}
	kernelNode := fleetAgent(t, view, "t-work/n4")
	if kernelNode.Status != "running" || kernelNode.CurrentOperationId != "e1" {
		t.Fatalf("kernel node agent is %+v", kernelNode)
	}
	if kernelNode.Tokens != 53 || math.Abs(kernelNode.Cost-0.4) > 1e-9 || kernelNode.Messages != 2 {
		t.Fatalf("kernel node usage is %+v", kernelNode)
	}
	if kernelNode.UpdatedAt != 5200 || kernelNode.Model != "m-kernel" {
		t.Fatalf("kernel node times/model are %+v", kernelNode)
	}
	for _, agent := range view.Agents {
		if agent.Id == "orphan-child" {
			t.Fatalf("an agent that does not hang off rootId must not leak into the subtree: %+v", agent)
		}
	}
	links := map[string]string{}
	for _, link := range view.Links {
		if link.Kind != "parent" {
			t.Fatalf("link kind is %q", link.Kind)
		}
		links[link.To] = link.From
	}
	if len(links) != 5 || links["c-proj"] != "c-global" || links["t-work/n4"] != "c-proj" || links["t-old/n3"] != "c-global" {
		t.Fatalf("parent links are %+v", links)
	}
	if got := view.Stats; got.Agents != 6 || got.Running != 2 || got.Tasks != 3 || got.Messages != 6 ||
		got.Tokens != 323 || math.Abs(got.Cost-1.32) > 1e-9 {
		t.Fatalf("stats are %+v", got)
	}
	taskIDs := []string{}
	tasks := map[string]FleetTask{}
	for _, task := range view.Tasks {
		taskIDs = append(taskIDs, task.Id)
		tasks[task.Id] = task
	}
	if !reflect.DeepEqual(taskIDs, []string{"t-work", "w1", "t-old"}) {
		t.Fatalf("tasks are %v", taskIDs)
	}
	work := tasks["t-work"]
	if work.Status != "running" || work.Phase != "running" || work.OwnerAgentId != "c-proj" ||
		work.Title != "实现编队页" || work.ProjectId != "p1" || work.StartedAt != 5000 || work.UpdatedAt != 6000 {
		t.Fatalf("graph task is %+v", work)
	}
	request := tasks["w1"]
	if request.Title != "编队页" || request.Status != "ready" || request.OwnerAgentId != "c-proj" ||
		request.StartedAt != 1200 || request.UpdatedAt != 1300 {
		t.Fatalf("work request is %+v", request)
	}
	if len(view.Events) != 5 {
		t.Fatalf("events are %+v", view.Events)
	}
	latest := view.Events[0]
	if latest.Type != "conversation.created" || latest.AgentId != "c-global" || latest.TaskId != "t-global" ||
		latest.At != 1000 || latest.Id != "5" {
		t.Fatalf("latest event is %+v", latest)
	}
	delegated := view.Events[1]
	if delegated.Type != "work.delegated" || delegated.AgentId != "c-proj" || delegated.TargetAgentId != "c-global" {
		t.Fatalf("delegation event is %+v", delegated)
	}
	nodeEvent := view.Events[3]
	if nodeEvent.Type != "graph.node.started" || nodeEvent.AgentId != "t-work/n4" {
		t.Fatalf("node event is %+v", nodeEvent)
	}
	if confirmed := view.Events[4]; confirmed.Type != "work.graph.confirmed" || confirmed.AgentId != "c-proj" {
		t.Fatalf("a graph event must map to the task's supervisor, got %+v", confirmed)
	}
	if len(view.Artifacts) != 2 {
		t.Fatalf("artifacts are %+v", view.Artifacts)
	}
	artifact := view.Artifacts[0]
	if artifact.ArtifactId != "a1" || artifact.ProducerAgentId != "t-work/n4" || artifact.ProducerTaskId != "t-work" ||
		artifact.TaskId != "t-work" || artifact.Version != 1 || artifact.Size != 100 || artifact.Title != "编队数据" {
		t.Fatalf("artifact is %+v", artifact)
	}
	if old := view.Artifacts[1]; old.ArtifactId != "a2" || old.ProducerAgentId != "t-old/n3" {
		t.Fatalf("second artifact is %+v", old)
	}
}
