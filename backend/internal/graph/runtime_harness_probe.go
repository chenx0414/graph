package graph

const (
	// HARNESS_EXPERIENCE_NAMESPACE is where a domain's lessons live. It is the
	// same namespace the harness backlog uses, so both kinds of harness
	// knowledge stay visible in one place.
	HARNESS_EXPERIENCE_NAMESPACE = "plans"
	// HARNESS_EXPERIENCE_PREFIX marks the artifacts that hold the lessons. It
	// is also the query prefix, so it has to be a slug on its own.
	HARNESS_EXPERIENCE_PREFIX = "harness-experience"
	// HARNESS_EXPERIENCE_SCHEMA is the identity of the stored shape.
	HARNESS_EXPERIENCE_SCHEMA = "graph.harness-experience@1"
	// HARNESS_MAX_CANDIDATES bounds one comparison. A contrast wider than this
	// stops being readable as a contrast.
	HARNESS_MAX_CANDIDATES = 12
	// HARNESS_EXPERIENCE_MAX_ENTRIES bounds one domain's store.
	HARNESS_EXPERIENCE_MAX_ENTRIES = 200
	// HARNESS_EXPERIENCE_MAX_BYTES is how much of a stored lesson set is read.
	HARNESS_EXPERIENCE_MAX_BYTES = 262144
	// HARNESS_MAX_FINAL_MESSAGE bounds the answer a candidate ended with.
	HARNESS_MAX_FINAL_MESSAGE = 2000
	// HARNESS_MAX_OUTPUT_VALUE bounds one submitted output value.
	HARNESS_MAX_OUTPUT_VALUE = 2000
)

// The harness probe compares the candidates of one task and reports what each
// of them did differently. It reports facts, never a verdict: choosing between
// candidates stays with the Agent, because this kind of task has no ground
// truth to appeal to.

// HarnessCandidateFacts is what one candidate run did.

type HarnessCandidateFacts struct {
	AnonId       string            `json:"anonId"`
	NodeId       string            `json:"nodeId"`
	Status       string            `json:"status"`
	Submitted    bool              `json:"submitted"`
	Outputs      []string          `json:"outputs"`
	OutputValues map[string]string `json:"outputValues,omitempty"`
	ToolCalls    int               `json:"toolCalls"`
	ToolErrors   int               `json:"toolErrors"`
	Tools        []string          `json:"tools"`
	InputTokens  int64             `json:"inputTokens"`
	OutputTokens int64             `json:"outputTokens"`
	ElapsedMs    int64             `json:"elapsedMs"`
	Messages     int               `json:"messages"`
	FinalMessage string            `json:"finalMessage,omitempty"`
}

// HarnessDifference is one behavioral difference between a candidate and the
// baseline it was compared against.

type HarnessDifference struct {
	Field     string `json:"field"`
	Baseline  string `json:"baseline"`
	Candidate string `json:"candidate"`
}

type HarnessComparison struct {
	GraphId string `json:"graphId"`
	Domain  string `json:"domain,omitempty"`
	// Baseline is the anonymous id of the candidate the others are compared
	// against; BaselineNodeId names the node it is.
	Baseline     string                         `json:"baseline"`
	BaselineNode string                         `json:"baselineNodeId"`
	Candidates   []HarnessCandidateFacts        `json:"candidates"`
	Differences  map[string][]HarnessDifference `json:"differences"`
	Experience   []HarnessExperienceEntry       `json:"experience"`
}

// HarnessCompareInput asks for the contrast of some candidates of one graph.
type HarnessCompareInput struct {
	GraphId        string
	NodeIds        []string
	BaselineNodeId string
	Domain         string
}

// HarnessProbeVariant is one candidate harness of a probe: the same task, a
// different set of prompt texts.
//
// Axis says how far the variant's lesson would reach. A general variant tries
// a change that should hold for every kind of work; a specific variant tries
// one that holds for this domain only.
type HarnessProbeVariant struct {
	Label   string            `json:"label"`
	Axis    string            `json:"axis,omitempty"`
	Recipe  string            `json:"recipe,omitempty"`
	Model   string            `json:"model,omitempty"`
	Harness map[string]string `json:"harness,omitempty"`
}

// HarnessProbeInput asks the host to run one task under several harnesses.
type HarnessProbeInput struct {
	Task      string                `json:"task"`
	Recipe    string                `json:"recipe,omitempty"`
	Model     string                `json:"model,omitempty"`
	Variants  []HarnessProbeVariant `json:"variants"`
	Domain    string                `json:"domain,omitempty"`
	TimeoutMs int                   `json:"timeoutMs,omitempty"`
}

// HarnessProbeCandidate names one variant of a probe and the node that ran it.
type HarnessProbeCandidate struct {
	Label  string `json:"label"`
	Axis   string `json:"axis"`
	NodeId string `json:"nodeId"`
	AnonId string `json:"anonId"`
}

// HarnessProbeResult is the contrast a probe produced.
type HarnessProbeResult struct {
	GraphId    string                  `json:"graphId"`
	Task       string                  `json:"task"`
	Candidates []HarnessProbeCandidate `json:"candidates"`
	Comparison HarnessComparison       `json:"comparison"`
	WaitedMs   int64                   `json:"waitedMs"`
	TimedOut   bool                    `json:"timedOut"`
}

// HARNESS_PROBE_MAX_VARIANTS bounds one probe. A contrast wider than this
// stops being readable as a contrast.
const HARNESS_PROBE_MAX_VARIANTS = 6
