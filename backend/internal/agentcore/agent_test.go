package agentcore

import (
	"errors"
	"testing"
)

type fakeSession struct {
	prompted  []string
	images    [][]Image
	compacted []string
	steered   []string
	interrupt []string
	stopped   bool
	closed    int
	inspect   Inspect
	turn      Turn
	promptErr error
}

func (s *fakeSession) Prompt(text string, images []Image) (Turn, error) {
	s.prompted = append(s.prompted, text)
	s.images = append(s.images, images)
	return s.turn, s.promptErr
}

func (s *fakeSession) Compact(customInstructions string) error {
	s.compacted = append(s.compacted, customInstructions)
	return nil
}

func (s *fakeSession) Steer(text string) error {
	s.steered = append(s.steered, text)
	return nil
}

func (s *fakeSession) Interrupt(text *string) error {
	value := ""
	if text != nil {
		value = *text
	}
	s.interrupt = append(s.interrupt, value)
	return nil
}

func (s *fakeSession) Stop() error {
	s.stopped = true
	return nil
}

func (s *fakeSession) Inspect() Inspect { return s.inspect }

func (s *fakeSession) Close() error {
	s.closed++
	return nil
}

func TestAgentForwardsPromptAndKeepsIdentity(t *testing.T) {
	session := &fakeSession{turn: Turn{FinalAssistantText: "done"}}
	agent, err := New(Identity{ID: "n1", ParentID: "p1", Kind: Node, Role: "worker", Name: "laneA"},
		func() (Session, error) { return session, nil })
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if got := agent.Identity(); got.ID != "n1" || got.ParentID != "p1" || got.Kind != Node || got.Role != "worker" || got.Name != "laneA" {
		t.Fatalf("identity = %+v", got)
	}
	turn, err := agent.Prompt("hello", []Image{{Type: "image", Data: "abc", MimeType: "image/png"}})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if turn.FinalAssistantText != "done" {
		t.Fatalf("turn = %+v", turn)
	}
	if len(session.prompted) != 1 || session.prompted[0] != "hello" {
		t.Fatalf("prompted = %v", session.prompted)
	}
	if len(session.images) != 1 || len(session.images[0]) != 1 || session.images[0][0].MimeType != "image/png" {
		t.Fatalf("images = %+v", session.images)
	}
}

func TestAgentPropagatesPromptError(t *testing.T) {
	session := &fakeSession{promptErr: errors.New("provider down")}
	agent, err := New(Identity{ID: "n1"}, func() (Session, error) { return session, nil })
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := agent.Prompt("hello", nil); err == nil || err.Error() != "provider down" {
		t.Fatalf("prompt error = %v", err)
	}
}

func TestAgentForwardsControlCalls(t *testing.T) {
	session := &fakeSession{}
	agent, err := New(Identity{ID: "n1"}, func() (Session, error) { return session, nil })
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := agent.Compact("summarize"); err != nil {
		t.Fatalf("compact: %v", err)
	}
	if err := agent.Steer("go on"); err != nil {
		t.Fatalf("steer: %v", err)
	}
	text := "stop"
	if err := agent.Interrupt(&text); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	if err := agent.Stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if len(session.compacted) != 1 || len(session.steered) != 1 || len(session.interrupt) != 1 || session.interrupt[0] != "stop" || !session.stopped {
		t.Fatalf("control calls = %+v", session)
	}
}

func TestAgentCloseIsIdempotentAndRejectsUse(t *testing.T) {
	session := &fakeSession{}
	agent, err := New(Identity{ID: "n1"}, func() (Session, error) { return session, nil })
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := agent.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := agent.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if session.closed != 1 {
		t.Fatalf("session closed %d times", session.closed)
	}
	if _, err := agent.Prompt("after", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("prompt after close = %v", err)
	}
	if agent.Closed() != true {
		t.Fatal("agent should report closed")
	}
}

func TestNewRejectsNilSession(t *testing.T) {
	if _, err := New(Identity{ID: "n1"}, func() (Session, error) { return nil, nil }); err == nil {
		t.Fatal("nil session should be rejected")
	}
}

func TestNewPropagatesOpenError(t *testing.T) {
	want := errors.New("open failed")
	if _, err := New(Identity{ID: "n1"}, func() (Session, error) { return nil, want }); !errors.Is(err, want) {
		t.Fatalf("open error = %v", err)
	}
}
