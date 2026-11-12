package agentcore

import (
	"errors"
	"fmt"
	"sync"
)

type Kind string

const (
	Global  Kind = "global"
	Project Kind = "project"
	Node    Kind = "node"
	Child   Kind = "child"
)

type Identity struct {
	ID       string `json:"id"`
	ParentID string `json:"parentId,omitempty"`
	Kind     Kind   `json:"kind"`
	Role     string `json:"role"`
	Name     string `json:"name"`
}

type Image struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

type Usage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

type ContextInfo struct {
	Mode                    string  `json:"mode"`
	SourceSessionId         *string `json:"sourceSessionId,omitempty"`
	SourceSessionFile       *string `json:"sourceSessionFile,omitempty"`
	SourceLeafId            *string `json:"sourceLeafId,omitempty"`
	SourceContextDigest     *string `json:"sourceContextDigest,omitempty"`
	ReboundFromBundleDigest *string `json:"reboundFromBundleDigest,omitempty"`
	ChildContextDigest      string  `json:"childContextDigest"`
}

type Binding struct {
	InstanceId        string `json:"instanceId"`
	NodeId            string `json:"nodeId"`
	DefinitionVersion string `json:"definitionVersion"`
}

type ExtensionError struct {
	Path  string `json:"path"`
	Error any    `json:"error"`
}

type Inspect struct {
	Binding              Binding          `json:"binding"`
	SessionId            string           `json:"sessionId"`
	SessionFile          string           `json:"sessionFile"`
	Model                *string          `json:"model,omitempty"`
	Messages             []any            `json:"messages"`
	LeafId               *string          `json:"leafId"`
	BundleDigest         *string          `json:"bundleDigest"`
	ToolPolicyDigest     *string          `json:"toolPolicyDigest"`
	RuntimePolicyDigest  *string          `json:"runtimePolicyDigest"`
	PiVersion            *string          `json:"piVersion"`
	Context              *ContextInfo     `json:"context,omitempty"`
	ActiveTools          []string         `json:"activeTools,omitempty"`
	RegisteredTools      []string         `json:"registeredTools,omitempty"`
	LoadedExtensions     []string         `json:"loadedExtensions,omitempty"`
	LoadedExtensionTools []string         `json:"loadedExtensionTools,omitempty"`
	ExtensionErrors      []ExtensionError `json:"extensionErrors,omitempty"`
}

type Turn struct {
	Inspect            Inspect `json:"inspect"`
	FinalAssistantText string  `json:"finalAssistantText"`
	StopReason         *string `json:"stopReason,omitempty"`
	ErrorMessage       *string `json:"errorMessage,omitempty"`
	Usage              *Usage  `json:"usage,omitempty"`
}

type Session interface {
	Prompt(text string, images []Image) (Turn, error)
	Compact(customInstructions string) error
	Steer(text string) error
	Interrupt(text *string) error
	Stop() error
	Inspect() Inspect
	Close() error
}

var ErrClosed = errors.New("agentcore: the agent is closed")

type Agent struct {
	identity Identity
	session  Session
	mutex    sync.Mutex
	closed   bool
}

func New(identity Identity, opener func() (Session, error)) (*Agent, error) {
	if identity.ID == "" {
		return nil, fmt.Errorf("agentcore: an agent identity needs an id")
	}
	if opener == nil {
		return nil, fmt.Errorf("agentcore: an agent needs a session opener")
	}
	session, err := opener()
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, fmt.Errorf("agentcore: the session opener returned no session")
	}
	return &Agent{identity: identity, session: session}, nil
}

func Adopt(identity Identity, session Session) (*Agent, error) {
	return New(identity, func() (Session, error) { return session, nil })
}

func (agent *Agent) Identity() Identity { return agent.identity }

func (agent *Agent) Session() Session { return agent.session }

func (agent *Agent) Closed() bool {
	agent.mutex.Lock()
	defer agent.mutex.Unlock()
	return agent.closed
}

func (agent *Agent) Prompt(text string, images []Image) (Turn, error) {
	if err := agent.ensureOpen(); err != nil {
		return Turn{}, err
	}
	return agent.session.Prompt(text, images)
}

func (agent *Agent) Compact(customInstructions string) error {
	if err := agent.ensureOpen(); err != nil {
		return err
	}
	return agent.session.Compact(customInstructions)
}

func (agent *Agent) Steer(text string) error {
	if err := agent.ensureOpen(); err != nil {
		return err
	}
	return agent.session.Steer(text)
}

func (agent *Agent) Interrupt(text *string) error {
	if err := agent.ensureOpen(); err != nil {
		return err
	}
	return agent.session.Interrupt(text)
}

func (agent *Agent) Stop() error {
	if err := agent.ensureOpen(); err != nil {
		return err
	}
	return agent.session.Stop()
}

func (agent *Agent) Inspect() Inspect {
	return agent.session.Inspect()
}

func (agent *Agent) Close() error {
	agent.mutex.Lock()
	if agent.closed {
		agent.mutex.Unlock()
		return nil
	}
	agent.closed = true
	agent.mutex.Unlock()
	return agent.session.Close()
}

func (agent *Agent) ensureOpen() error {
	agent.mutex.Lock()
	defer agent.mutex.Unlock()
	if agent.closed {
		return ErrClosed
	}
	return nil
}
