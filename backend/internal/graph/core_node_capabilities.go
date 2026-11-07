package graph

type CapabilityLoadFact struct {
	ID          string   `json:"id"`
	Version     string   `json:"version"`
	Kind        *string  `json:"kind"`
	Loaded      bool     `json:"loaded"`
	Executable  bool     `json:"executable"`
	Reason      *string  `json:"reason"`
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Path        *string  `json:"path,omitempty"`
	Tools       []string `json:"tools,omitempty"`
}

type CapabilityUsageFact struct {
	ID           string   `json:"id"`
	Version      string   `json:"version"`
	Kind         *string  `json:"kind"`
	Name         string   `json:"name"`
	Tools        []string `json:"tools"`
	Calls        int      `json:"calls"`
	Successes    int      `json:"successes"`
	Failures     int      `json:"failures"`
	Pending      int      `json:"pending"`
	LastCalledAt *int64   `json:"lastCalledAt"`
	SuccessRate  *float64 `json:"successRate"`
}

type NodeCapabilityLoadInput struct {
	TaskId              string
	NodeId              string
	InstanceId          string
	OperationId         string
	ReadOnly            bool
	Report              []RuntimeCapabilityLoadFact
	Digest              string
	ToolPolicyDigest    string
	RuntimePolicyDigest string
}

type nodeCapabilityLoadRecord struct {
	Version             int                         `json:"version"`
	Digest              *string                     `json:"digest"`
	ToolPolicyDigest    *string                     `json:"toolPolicyDigest"`
	RuntimePolicyDigest *string                     `json:"runtimePolicyDigest"`
	Facts               []RuntimeCapabilityLoadFact `json:"facts"`
}

func nodeEntryOptional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func RecordCapabilityLoad(store *TaskStore, input NodeCapabilityLoadInput) {
	facts := input.Report
	if facts == nil {
		facts = []RuntimeCapabilityLoadFact{}
	}
	record := nodeCapabilityLoadRecord{
		Version:             2,
		Digest:              nodeEntryOptional(input.Digest),
		ToolPolicyDigest:    nodeEntryOptional(input.ToolPolicyDigest),
		RuntimePolicyDigest: nodeEntryOptional(input.RuntimePolicyDigest),
		Facts:               facts,
	}
	kernelExec(store.Db, `INSERT INTO node_capabilities(task_id,node_id,instance_id,operation_id,read_only,loaded,created_at)
	  VALUES(?,?,?,?,?,?,?)`,
		input.TaskId, input.NodeId, nodeEntryID(input.InstanceId), nodeEntryID(input.OperationId),
		nodeEntryReadOnly(input.ReadOnly), CanonicalJSON(record), NowMillis())
}

func nodeEntryReadOnly(readOnly bool) int {
	if readOnly {
		return 1
	}
	return 0
}

func RecordNodeSession(store *TaskStore, instanceId, sessionId, sessionFile string) {
	kernelExec(store.Db, "INSERT OR REPLACE INTO node_sessions VALUES(?,?,?,?)",
		instanceId, sessionId, nodeEntryID(sessionFile), NowMillis())
}
