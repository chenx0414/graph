package harness

import (
	"sync"
	"testing"
	"time"
)

func TestCreatingAConversationAnswersWhileDispatchReads(t *testing.T) {
	root := t.TempDir()
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a session: %v", err)
	}
	defer session.Close()

	if healthy, healthErr := session.Healthy(); healthErr != nil || !healthy {
		t.Fatalf("the app must be healthy before the check: %v (healthy=%v)", healthErr, healthy)
	}

	done := make(chan struct{})
	var busy sync.WaitGroup
	busy.Add(1)
	go func() {
		defer busy.Done()
		for i := 0; i < 60; i++ {
			select {
			case <-done:
				return
			default:
			}
			_, _ = session.CreateConversation("warm-"+itoa(i), "warming the dispatch loop")
		}
	}()

	answered := make(chan error, 1)
	go func() {
		_, createErr := session.CreateConversation("gate", "the console must answer this")
		answered <- createErr
	}()

	select {
	case err := <-answered:
		close(done)
		busy.Wait()
		if err != nil {
			t.Fatalf("creating a conversation failed: %v", err)
		}
	case <-time.After(45 * time.Second):
		close(done)
		t.Fatalf("POST /api/conversations did not answer within 45s while dispatch was reading")
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
