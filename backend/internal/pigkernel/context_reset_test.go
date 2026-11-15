package pigkernel

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
	_ "modernc.org/sqlite"
)

func TestResetConversationClearsTheAgentContext(t *testing.T) {
	ctx := context.Background()
	database := filepath.Join(t.TempDir(), "tasks.sqlite")
	resident, err := openResident(ctx, database)
	if err != nil {
		t.Fatalf("open the kernel: %v", err)
	}
	conversation, err := conversationFor(ctx, resident.kernel, "agent-x", harness.AgentChange{})
	if err != nil {
		t.Fatalf("open the agent conversation: %v", err)
	}
	if _, err := conversation.Commit(ctx, func(tx durable.Tx) (any, error) {
		_, appendErr := tx.AppendEntry(conversation.Id(), durable.EntryDraft{
			HeadSelf: true,
			Model:    []ai.Message{ai.UserMessage{Content: ai.UserText("remember-me"), Timestamp: 1}},
		})
		return nil, appendErr
	}); err != nil {
		t.Fatalf("seed the agent context: %v", err)
	}
	before, err := conversation.Context(ctx, nil)
	if err != nil {
		t.Fatalf("read the context: %v", err)
	}
	if !strings.Contains(messagesJSON(before.Messages), "remember-me") {
		t.Fatalf("the fixture reaches the context, messages %s", messagesJSON(before.Messages))
	}

	reset, err := ResetConversation(ctx, database, "agent-x")
	if err != nil {
		t.Fatalf("reset the conversation: %v", err)
	}
	if !reset {
		t.Fatal("a known identity is reset")
	}
	after, err := resident.kernel.Harness().Conversation(ctx, conversation.Id())
	if err != nil {
		t.Fatalf("reopen the conversation: %v", err)
	}
	view, err := after.Context(ctx, nil)
	if err != nil {
		t.Fatalf("read the fresh context: %v", err)
	}
	if strings.Contains(messagesJSON(view.Messages), "remember-me") {
		t.Fatalf("the reset clears the messages, context %s", messagesJSON(view.Messages))
	}

	reset, err = ResetConversation(ctx, database, "missing-agent")
	if err != nil {
		t.Fatalf("reset an unknown identity: %v", err)
	}
	if reset {
		t.Fatal("an unknown identity has no context to reset")
	}
}

func messagesJSON(messages []ai.Message) string {
	payload, _ := json.Marshal(messages)
	return string(payload)
}
