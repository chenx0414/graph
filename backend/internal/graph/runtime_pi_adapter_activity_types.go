package graph

type piAdapterPart struct {
	entryId   string
	partId    string
	text      string
	buffer    string
	lastFlush int64
	ordinal   int
}

type PiAdapterToolActivity struct {
	ToolCallId string `json:"toolCallId"`
	Name       string `json:"name"`
	Summary    string `json:"summary"`
	State      string `json:"state"`
	Output     string `json:"output,omitempty"`
}

type PiAdapterActivityRecord struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	ToolCallId string `json:"toolCallId,omitempty"`
	Name       string `json:"name,omitempty"`
	Summary    string `json:"summary,omitempty"`
	State      string `json:"state,omitempty"`
	Message    string `json:"message,omitempty"`
	Output     string `json:"output,omitempty"`
	Ordinal    int    `json:"ordinal"`
}

type PiAdapterAskedQuestion struct {
	Prompt       string   `json:"prompt"`
	Why          string   `json:"why"`
	Options      []string `json:"options"`
	Recommended  string   `json:"recommended"`
	Multiple     bool     `json:"multiple"`
	ToSupervisor bool     `json:"-"`
	RequestID    string   `json:"-"`
}

type PiAdapterSupervisorNotice struct {
	Text            string
	Milestone       string
	WorkID          string
	Evidence        string
	ArtifactID      string
	ArtifactVersion int
	EvidenceExcerpt string
	EvidenceFailure string
	RequestID       string
}
