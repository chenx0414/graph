package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/MichaelKinsy/PiG/chord/delta"
	"github.com/MichaelKinsy/PiG/durable"
)

// The frozen execution.
//
// A Graph execution is one turn the daemon admitted: a model, a set of tools
// and an input. When the daemon dies while that turn runs, the recovery has to
// know which execution the kernel was running, which model it was admitted
// with and which input it was waiting for. The kernel's own records answer the
// last two. The frozen execution answers the first, and it is a durable
// document, so it survives the crash that made it necessary.
//
// The document's shape is the one the TypeScript kernel wrote: the frozen
// records live under `conversations`, each one encoded as a JSON string. A
// database that carries frozen executions therefore keeps them across the
// switch, and the old kernel can still read what the new one wrote.

// FrozenExecution is one frozen Graph execution.
//
// The record is the Graph's own: the kernel stores it, hands it back and never
// reads it. The fields the kernel does read are the ones that identify the
// execution and the admission it was waiting for.
type FrozenExecution struct {
	// ConversationId is the durable conversation the execution ran in.
	ConversationId int64
	// Identity is the Graph identity the execution belonged to.
	Identity string
	// ExecutionId is the Graph execution the record describes.
	ExecutionId string
	// InputRequestId is the admission identity of the input.
	InputRequestId string
	// Record is the frozen record itself.
	Record map[string]any
}

// executionsDoc is the durable document that holds the frozen executions.
//
// The scope is the session: one frozen execution per durable conversation, and
// the newest one is the one a recovery needs.
var executionsDoc = durable.DefineDoc[map[string]any](durable.DocDefinition[map[string]any]{
	CommonDocDefinition: durable.CommonDocDefinition[map[string]any]{
		Kind:    "graph.frozen-executions",
		Version: 1,
		Initial: func() map[string]any { return map[string]any{"conversations": map[string]any{}} },
	},
	DocumentSemantics: durable.DocumentSemantics{Scope: durable.ScopeSession},
})

// FreezeExecution stores the frozen record of one execution.
//
// The record belongs to the durable conversation of the identity: a
// conversation runs one execution at a time, so the newest record is the one
// the recovery reads.
func FreezeExecution(ctx context.Context, database string, identity string, record map[string]any) error {
	resident, err := openResident(ctx, database)
	if err != nil {
		return err
	}
	conversationId, err := conversationIdOf(ctx, resident.kernel, identity)
	if err != nil {
		return err
	}
	if conversationId == 0 {
		return fmt.Errorf("pig kernel: the identity %s has no durable conversation to freeze", identity)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("pig kernel: the frozen execution is not serializable: %w", err)
	}
	root, err := resident.kernel.Harness().Root(ctx, nil)
	if err != nil {
		return err
	}
	_, err = root.Commit(ctx, func(tx durable.Tx) (any, error) {
		conversations, err := conversationIndex(tx, executionsDoc)
		if err != nil {
			return nil, err
		}
		return nil, conversations.Set(fmt.Sprintf("%d", conversationId), string(encoded))
	})
	if err != nil {
		return fmt.Errorf("pig kernel: the frozen execution is not stored: %w", err)
	}
	return nil
}

// FrozenExecutions reads every frozen execution of the database.
//
// The order is the conversation order, so a recovery walks the conversations
// the way the kernel numbered them.
func FrozenExecutions(ctx context.Context, database string) ([]FrozenExecution, error) {
	resident, err := openResident(ctx, database)
	if err != nil {
		return nil, err
	}
	root, err := resident.kernel.Harness().Root(ctx, nil)
	if err != nil {
		return nil, err
	}
	executions := []FrozenExecution{}
	_, err = root.Commit(ctx, func(tx durable.Tx) (any, error) {
		conversations, err := conversationIndex(tx, executionsDoc)
		if err != nil {
			return nil, err
		}
		for _, key := range conversations.Keys() {
			encoded, ok := conversations.Lookup(key)
			if !ok {
				continue
			}
			text, ok := encoded.(string)
			if !ok {
				continue
			}
			record := map[string]any{}
			if err := json.Unmarshal([]byte(text), &record); err != nil {
				// A frozen record the daemon cannot read is not a reason to
				// refuse every other execution: the ones that can be read are
				// still recoverable.
				continue
			}
			conversationId, ok := conversationIdFromKey(key)
			if !ok {
				continue
			}
			executions = append(executions, FrozenExecution{
				ConversationId: conversationId,
				Identity:       recordString(record, "identity"),
				ExecutionId:    recordString(record, "executionId"),
				InputRequestId: recordString(record, "inputRequestId"),
				Record:         record,
			})
		}
		return nil, nil
	})
	if err != nil {
		return nil, fmt.Errorf("pig kernel: the frozen executions are not readable: %w", err)
	}
	return executions, nil
}

// ExecutionReceipt is what the kernel knows about the input of one execution.
//
// A completed receipt is the proof that the kernel finished the turn: the
// Graph settles its operation from it, and the model is not asked again.
type ExecutionReceipt struct {
	// Found reports whether the kernel still holds the admission.
	Found bool
	// Completed reports whether the kernel finished the turn.
	Completed bool
	// Status is the admission's status: done, unanswered, placed or queued.
	Status string
	// Text is the assistant answer of a completed admission.
	Text string
	// StopReason is why the answer ended.
	StopReason string
	// Usage is what the answer reported.
	Usage *Usage
}

// ReadExecutionReceipt reads the admission of one frozen execution.
//
// A missing admission means the kernel never accepted the input; a settled one
// that is not `done` means the turn failed. Only a `done` admission carries an
// answer the Graph may settle with.
func ReadExecutionReceipt(ctx context.Context, database string, execution FrozenExecution) (ExecutionReceipt, error) {
	resident, err := openResident(ctx, database)
	if err != nil {
		return ExecutionReceipt{}, err
	}
	root, err := resident.kernel.Harness().Root(ctx, nil)
	if err != nil {
		return ExecutionReceipt{}, err
	}
	var record *durable.SubmissionRecord
	_, err = root.Commit(ctx, func(tx durable.Tx) (any, error) {
		found, err := tx.SubmissionByRequest(durable.ConversationId(execution.ConversationId), execution.InputRequestId)
		if err != nil {
			return nil, err
		}
		record = found
		return nil, nil
	})
	if err != nil {
		return ExecutionReceipt{}, fmt.Errorf("pig kernel: the admission of %s is not readable: %w", execution.ExecutionId, err)
	}
	if record == nil {
		return ExecutionReceipt{}, nil
	}
	receipt := ExecutionReceipt{Found: true, Status: string(record.Status)}
	if record.Status == durable.SubmissionDone {
		receipt.Completed = true
	}
	if record.Answer == nil {
		return receipt, nil
	}
	conversation, err := resident.kernel.Harness().Conversation(ctx, durable.ConversationId(execution.ConversationId))
	if err != nil {
		return ExecutionReceipt{}, err
	}
	if conversation == nil {
		return receipt, nil
	}
	text, stopReason, usage, err := answerText(ctx, conversation, *record.Answer)
	if err != nil {
		return ExecutionReceipt{}, err
	}
	receipt.Text = text
	receipt.StopReason = stopReason
	receipt.Usage = usage
	return receipt, nil
}

// conversationIndex reads the conversation index of one durable document.
//
// The index is the shape the TypeScript kernel wrote: the conversations live
// under `conversations`, keyed by the durable conversation id.
func conversationIndex(tx durable.Tx, document durable.DocToken[map[string]any]) (*delta.Object, error) {
	draft, err := durable.TxDoc[map[string]any](tx, document)
	if err != nil {
		return nil, err
	}
	conversations := draft.Object("conversations")
	if conversations == nil {
		if err := draft.Set("conversations", map[string]any{}); err != nil {
			return nil, err
		}
		conversations = draft.Object("conversations")
	}
	if conversations == nil {
		return nil, fmt.Errorf("pig kernel: the document has no conversation index")
	}
	return conversations, nil
}

// conversationIdOf reads the durable conversation of one identity.
func conversationIdOf(ctx context.Context, kernel *Kernel, identity string) (int64, error) {
	root, err := kernel.Harness().Root(ctx, nil)
	if err != nil {
		return 0, err
	}
	var conversationId int64
	_, err = root.Commit(ctx, func(tx durable.Tx) (any, error) {
		conversations, err := conversationIndex(tx, identitiesDoc)
		if err != nil {
			return nil, err
		}
		value, found := conversations.Lookup(identity)
		if !found {
			return nil, nil
		}
		id, ok := conversationNumber(value)
		if !ok {
			return nil, nil
		}
		conversationId = id
		return nil, nil
	})
	if err != nil {
		return 0, fmt.Errorf("pig kernel: the identity index is not readable: %w", err)
	}
	return conversationId, nil
}

// recordString reads one string field of a frozen record.
func recordString(record map[string]any, name string) string {
	value, _ := record[name].(string)
	return value
}

// conversationIdFromKey reads a durable conversation id out of an index key.
func conversationIdFromKey(key string) (int64, bool) {
	id, err := strconv.ParseInt(key, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}
