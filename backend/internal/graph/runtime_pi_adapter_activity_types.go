package graph

// piAdapterPart is one live text part of one assistant message.
type piAdapterPart struct {
	entryId   string
	partId    string
	text      string
	buffer    string
	lastFlush int64
	ordinal   int
}

// PiAdapterToolActivity is one executed tool call in the turn record.
type PiAdapterToolActivity struct {
	ToolCallId string `json:"toolCallId"`
	Name       string `json:"name"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
}

// PiAdapterActivityRecord is one ordered turn activity entry.
type PiAdapterActivityRecord struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	ToolCallId string `json:"toolCallId,omitempty"`
	Name       string `json:"name,omitempty"`
	Summary    string `json:"summary,omitempty"`
	State      string `json:"state,omitempty"`
	Ordinal    int    `json:"ordinal"`
}

// PiAdapterAskedQuestion is the agent's own question to the user.
type PiAdapterAskedQuestion struct {
	Prompt       string   `json:"prompt"`
	Why          string   `json:"why"`
	Options      []string `json:"options"`
	Multiple     bool     `json:"multiple"`
	ToSupervisor bool     `json:"-"`
	RequestID    string   `json:"-"`
}

// PiAdapterSupervisorNotice is the notice half of the supervisor channel: a
// project supervisor reports what happened and keeps working.
type PiAdapterSupervisorNotice struct {
	Text      string
	Milestone string
	WorkID    string
	Evidence  string
	// ArtifactID names evidence the receiver cannot reach on its own: the global
	// supervisor has no project, so a project's task-scoped artifact is invisible
	// to it. The sender reads it and the delivery carries the bytes.
	ArtifactID      string
	ArtifactVersion int
	EvidenceExcerpt string
	// EvidenceFailure is why the excerpt is missing; the receiver reads a reason
	// instead of an unexplained empty attachment.
	EvidenceFailure string
	RequestID       string
}
