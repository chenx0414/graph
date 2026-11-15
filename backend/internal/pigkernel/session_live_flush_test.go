package pigkernel

import (
	"context"
	"sync"
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
)

type flushConversation struct {
	harness.Conversation
	mutex sync.Mutex
	calls int
	page  durable.Page[durable.EntryRecord, durable.Cursor]
}

func (conversation *flushConversation) Id() durable.ConversationId { return 7 }

func (conversation *flushConversation) Entries(context.Context, durable.EntryQuery, int, durable.Cursor) (durable.Page[durable.EntryRecord, durable.Cursor], error) {
	conversation.mutex.Lock()
	defer conversation.mutex.Unlock()
	conversation.calls++
	if conversation.calls == 1 {
		return durable.Page[durable.EntryRecord, durable.Cursor]{}, nil
	}
	return conversation.page, nil
}

func TestStoppingTheLiveWatchPublishesTheReplyThatLandedLast(t *testing.T) {
	page := durable.Page[durable.EntryRecord, durable.Cursor]{Items: []durable.EntryRecord{{
		Id: 9, Kind: "pi.assistant",
		Model: []ai.Message{ai.AssistantMessage{Content: []ai.AssistantContentBlock{ai.TextContent{Text: "E2E-GRAPH-OK"}}}},
	}}}
	published := []map[string]any{}
	session := &Session{
		conversation: &flushConversation{page: page},
		OnEvent:      func(event map[string]any) { published = append(published, event) },
	}
	stop := session.watchLive(context.Background())
	stop()
	found := false
	for _, event := range published {
		if event["type"] != "message_end" {
			continue
		}
		message, _ := event["message"].(map[string]any)
		if kernelText(message["content"]) == "E2E-GRAPH-OK" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the reply committed just before the turn ended must reach the node transcript, published %v", published)
	}
}

func kernelText(content any) string {
	parts, _ := content.([]any)
	out := ""
	for _, part := range parts {
		record, _ := part.(map[string]any)
		if text, ok := record["text"].(string); ok {
			out += text
		}
	}
	return out
}
