package graph

import (
	"regexp"

	"encoding/json"
)

// NodeCapabilityView is one bound capability in the node detail.
type NodeCapabilityView struct {
	ID         string   `json:"id"`
	Version    string   `json:"version"`
	Kind       *string  `json:"kind"`
	Name       string   `json:"name"`
	Tools      []string `json:"tools"`
	Bound      bool     `json:"bound"`
	Loaded     *bool    `json:"loaded"`
	Executable *bool    `json:"executable"`
	State      string   `json:"state"`
	Reason     *string  `json:"reason"`
}

// NodeRunNode is the node identity inside the node detail.
type NodeRunNode struct {
	ID                string          `json:"id"`
	Kind              string          `json:"kind"`
	Action            string          `json:"action"`
	Role              *string         `json:"role"`
	Status            string          `json:"status"`
	ActivationID      *string         `json:"activationId"`
	OutputVersion     int64           `json:"outputVersion"`
	StallCount        int64           `json:"stallCount"`
	DefinitionVersion *string         `json:"definitionVersion,omitempty"`
	Input             json.RawMessage `json:"input,omitempty"`
}

// NodeRunInstance is the instance a node runs in.
type NodeRunInstance struct {
	ID                string   `json:"id"`
	Model             *string  `json:"model"`
	DefinitionVersion *string  `json:"definitionVersion"`
	Used              int64    `json:"used"`
	Budget            *int64   `json:"budget"`
	Unlimited         bool     `json:"unlimited"`
	ModelsUsed        []string `json:"modelsUsed"`
}

// NodeRunSession is the Pi session a node instance is bound to.
type NodeRunSession struct {
	SessionID   string  `json:"sessionId"`
	SessionFile *string `json:"sessionFile"`
}

// NodeRunInvocation is one provider call of a node.
type NodeRunInvocation struct {
	ID          string      `json:"id"`
	Model       string      `json:"model"`
	Purpose     string      `json:"purpose"`
	Usage       *TokenUsage `json:"usage"`
	UsageSource UsageSource `json:"usageSource"`
	Cost        Json        `json:"cost"`
}

// NodeRunQuestion is one question a node asked.
type NodeRunQuestion struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
	Data   Json   `json:"data"`
}

// NodeRunQueued is one message waiting for this node to become free. Only chat
// is listed: a delivery or a control row is the runtime handing work around, not
// something the reader typed and may want to take back or wait out.
type NodeRunQueued struct {
	Seq       int64  `json:"seq"`
	Text      string `json:"text"`
	CreatedAt int64  `json:"createdAt"`
}

// NodeRunEvidence is one acceptance item a node proved.
type NodeRunEvidence struct {
	AcceptanceID string  `json:"acceptanceId"`
	Valid        bool    `json:"valid"`
	CommitSha    *string `json:"commitSha"`
}

// NodeRunTiming is the time ledger of a node.
// NodeThroughput is the newest settled request of one node: what it wrote and how
// long the provider took, so the node chat can print tokens per second next to the
// same numbers the conversation footer shows.
type NodeThroughput struct {
	OutputTokens    *int64   `json:"outputTokens"`
	LatencyMs       *int64   `json:"latencyMs"`
	TokensPerSecond *float64 `json:"tokensPerSecond"`
}

type NodeRunTiming struct {
	TotalMs    *int64 `json:"totalMs"`
	RunMs      *int64 `json:"runMs"`
	WaitingMs  int64  `json:"waitingMs"`
	PauseMs    *int64 `json:"pauseMs"`
	UserWaitMs *int64 `json:"userWaitMs"`
	InProgress bool   `json:"inProgress"`
}

// NodeRunView is the read-only node detail.
type NodeRunView struct {
	TaskID           string                `json:"taskId"`
	NodeID           string                `json:"nodeId"`
	Context          *ContextFacts         `json:"context"`
	Capabilities     []NodeCapabilityView  `json:"capabilities"`
	CapabilityUsage  []CapabilityUsageFact `json:"capabilityUsage"`
	CapabilityDigest *string               `json:"capabilityDigest"`
	Node             NodeRunNode           `json:"node"`
	Instance         *NodeRunInstance      `json:"instance"`
	Session          *NodeRunSession       `json:"session"`
	Operations       []OperationRun        `json:"operations"`
	Invocations      []NodeRunInvocation   `json:"invocations"`
	Questions        []NodeRunQuestion     `json:"questions"`
	Queued           []NodeRunQueued       `json:"queued"`
	Evidence         []NodeRunEvidence     `json:"evidence"`
	Timing           NodeRunTiming         `json:"timing"`
	Throughput       NodeThroughput        `json:"throughput"`
	Entries          []NodeEntry           `json:"entries"`
	EntryCount       int                   `json:"entryCount"`
	HasOlder         bool                  `json:"hasOlder"`
	HasNewer         bool                  `json:"hasNewer"`
	Phase            string                `json:"phase"`
}

// nodeRunSpec is the v1 node declaration stored in nodes.spec.
type nodeRunSpec struct {
	Kind              string          `json:"kind"`
	Action            string          `json:"action"`
	DefinitionVersion *string         `json:"definitionVersion"`
	Role              *string         `json:"role"`
	Input             json.RawMessage `json:"input"`
}

// nodeRunDefinitionSpec is the capability binding of a stored definition.
type nodeRunDefinitionSpec struct {
	Capabilities []struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	} `json:"capabilities"`
	Prompts *struct {
		Agent *struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"agent"`
		Tool *struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"tool"`
	} `json:"prompts"`
}

// nodeRunBinding is one capability bound to a node.
type nodeRunBinding struct {
	ID      string
	Version string
}

// nodeRunDefinitionMatch splits a `id@version` definition reference.
var nodeRunDefinitionMatch = regexp.MustCompile(`^(.*)@(\d+)$`)
