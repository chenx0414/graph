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
