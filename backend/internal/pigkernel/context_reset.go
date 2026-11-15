package pigkernel

import (
	"context"

	"github.com/MichaelKinsy/PiG/durable"
)

func ResetConversation(ctx context.Context, database, identity string) (bool, error) {
	resident, err := openResident(ctx, database)
	if err != nil {
		return false, err
	}
	root, err := resident.kernel.Harness().Root(ctx, nil)
	if err != nil {
		return false, err
	}
	var conversationId durable.ConversationId
	found := false
	if _, err := root.Commit(ctx, func(tx durable.Tx) (any, error) {
		draft, err := durable.TxDoc[map[string]any](tx, identitiesDoc)
		if err != nil {
			return nil, err
		}
		conversations := draft.Object("conversations")
		if conversations == nil {
			return nil, nil
		}
		value, ok := conversations.Lookup(identity)
		if !ok {
			return nil, nil
		}
		number, ok := conversationNumber(value)
		if !ok {
			return nil, nil
		}
		conversationId = durable.ConversationId(number)
		found = true
		return nil, nil
	}); err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	conversation, err := resident.kernel.Harness().Conversation(ctx, conversationId)
	if err != nil {
		return false, err
	}
	if conversation == nil {
		return false, nil
	}
	if err := conversation.Reset(ctx, nil); err != nil {
		return false, err
	}
	return true, nil
}
