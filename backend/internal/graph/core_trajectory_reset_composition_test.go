// graph:table-writes-exempt: a test seeds the conversation it reads back
package graph

import (
	"testing"
)

// After /new the card describes the reset context, not every message ever carried.
func TestANewContextResetsTheCompositionTheCardShows(t *testing.T) {
	store, _, _, _ := answersFixture(t)
	long := ""
	for len(long) < 4000 {
		long += "the assistant wrote this before the reset. "
	}
	for index := 0; index < 3; index++ {
		AppendMessage(store, MessageInput{ConversationID: "c1", Role: MessageRoleUser, Kind: "chat", Text: long, State: MessageStateDone})
		AppendMessage(store, MessageInput{ConversationID: "c1", Role: MessageRoleAssistant, Kind: "chat", Text: long, State: MessageStateDone})
	}
	before := BuildConversationTrajectory(store, "c1")
	if before.Composition.UserMessages <= 0 || before.Composition.AssistantReply <= 0 {
		t.Fatalf("the fixture wrote messages the composition must count, got %+v", before.Composition)
	}

	(&TaskRuntime{store: store}).Conversations().NewContext("c1", "req-new-context")

	after := BuildConversationTrajectory(store, "c1")
	if after.Composition.UserMessages != 0 || after.Composition.AssistantReply != 0 {
		t.Fatalf("after /new the card must describe the reset context, not the transcript: %+v", after.Composition)
	}
}
