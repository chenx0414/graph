// graph:table-writes-exempt: the test seeds the rows the projection reads
package graph

import "testing"

func TestFleetProjectsSpawnedChildUsageAndMessages(t *testing.T) {
	fixture := seedFleetFixture(t)
	fixture.exec(t, `INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('t-child','p1','child',6,'chatting','c-child')`)
	fixture.exec(t, `INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('c-child','p1','p1','t-child','子 Agent',6,1600,'child')`)
	fixture.exec(t, `INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t-child','master','{"role":"master","model":"m-child"}','i-child')`)
	fixture.exec(t, `INSERT INTO instances(id,task_id,node_id,model) VALUES('i-child','t-child','master','m-child')`)
	fixture.exec(t, `INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active)
		VALUES('o-child','t-child','master','i-child',1,'{"action":"master"}','succeeded',100,0)`)
	fixture.exec(t, `INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose,dispatched_at,settled_at)
		VALUES('inv-child','o-child','i-child','m-child','{"input":11,"output":4}','{"amount":0.03}','completion',6000,6100)`)
	fixture.exec(t, `INSERT INTO messages(id,conversation_id,role,kind,text,state,created_at,updated_at)
		VALUES('msg-child','c-child','user','chat','做子任务','done',6000,6000)`)
	RegisterAgent(fixture.store, AgentRegistration{Id: "c-child", ParentId: "c-global", Kind: "child", Role: "child",
		Name: "子 Agent", ConversationId: "c-child", TaskId: "t-child", ProjectId: "p1", Workspace: "/tmp/child",
		Model: "m-child", CreatedAt: 1600})
	view := fixture.fleet(t, "")
	child := fleetAgent(t, view, "c-child")
	if child.Tokens != 15 || child.Requests != 1 || child.Messages != 1 || child.Model != "m-child" {
		t.Fatalf("child usage = %+v", child)
	}
	if child.ParentId != "c-global" || child.Kind != "child" {
		t.Fatalf("child identity = %+v", child)
	}
}
