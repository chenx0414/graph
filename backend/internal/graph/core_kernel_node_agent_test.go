// graph:table-writes-exempt: the test seeds the rows the gate reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestAdmittingAKernelNodeRegistersItsAgent(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "node-agent.sqlite"))
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp','[]')`); err != nil {
		t.Fatalf("project: %v", err)
	}
	store.CreateGraphTask("g1", "p1", "", 1)
	kernel := NewKernelStore(store)
	definition := GraphDefinition{SchemaVersion: 2, Name: "g1", Nodes: map[string]NodeDefinition{"laneA": {Recipe: "coder@1", Task: "do it"}}}
	kernel.PublishRevision("g1", definition, "test", 1)
	kernel.AdmitNode("g1", 1, "laneA", AdmitNodeInput{InstanceId: "i1"})
	agent := AgentById(store, "g1/laneA")
	if agent == nil {
		t.Fatal("admitting a kernel node must register its agent")
	}
	if agent.Kind != "node" || agent.TaskId != "g1" || agent.NodeId != "laneA" || agent.ProjectId != "p1" {
		t.Fatalf("agent = %+v", agent)
	}
}
