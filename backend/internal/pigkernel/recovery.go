package pigkernel

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/MichaelKinsy/PiG/chord/delta"
	"github.com/MichaelKinsy/PiG/durable"
)


type FrozenExecution struct {
	ConversationId int64
	Identity string
	ExecutionId string
	InputRequestId string
	Record map[string]any
}

var executionsDoc = durable.DefineDoc[map[string]any](durable.DocDefinition[map[string]any]{
	CommonDocDefinition: durable.CommonDocDefinition[map[string]any]{
		Kind:    "graph.frozen-executions",
		Version: 1,
		Initial: func() map[string]any { return map[string]any{"conversations": map[string]any{}} },
		CheckpointWhen: func(map[string]any, []durable.Op, durable.CheckpointInfo) bool { return true },
	},
	DocumentSemantics: durable.DocumentSemantics{Scope: durable.ScopeSession},
})

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

func MarkRecoveryAttempt(ctx context.Context, database string, conversationId int64, reason string) error {
	resident, err := openResident(ctx, database)
	if err != nil {
		return err
	}
	if conversationId == 0 {
		return fmt.Errorf("pig kernel: the conversation of the failed recovery is unknown")
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
		key := fmt.Sprintf("%d", conversationId)
		encoded, found := conversations.Lookup(key)
		if !found {
			return nil, fmt.Errorf("pig kernel: the frozen execution of %d is gone", conversationId)
		}
		text, ok := encoded.(string)
		if !ok {
			return nil, fmt.Errorf("pig kernel: the frozen execution of %d is not readable", conversationId)
		}
		record := map[string]any{}
		if err := json.Unmarshal([]byte(text), &record); err != nil {
			return nil, fmt.Errorf("pig kernel: the frozen execution of %d is not readable: %w", conversationId, err)
		}
		record["recoveryAttemptedAt"] = nowMillis()
		record["recoveryFailure"] = reason
		updated, err := json.Marshal(record)
		if err != nil {
			return nil, fmt.Errorf("pig kernel: the frozen execution is not serializable: %w", err)
		}
		return nil, conversations.Set(key, string(updated))
	})
	if err != nil {
		return fmt.Errorf("pig kernel: the recovery attempt is not recorded: %w", err)
	}
	return nil
}

func RecoveryFailure(record map[string]any) (string, bool) {
	reason, ok := record["recoveryFailure"].(string)
	if !ok || strings.TrimSpace(reason) == "" {
		return "", false
	}
	return reason, true
}

func AbortStalledConversation(ctx context.Context, database, identity string) (bool, error) {
	resident, err := openResident(ctx, database)
	if err != nil {
		return false, err
	}
	conversationId, err := conversationIdOf(ctx, resident.kernel, identity)
	if err != nil || conversationId == 0 {
		return false, err
	}
	inspection, err := resident.kernel.Harness().Inspect(ctx)
	if err != nil {
		return false, err
	}
	stalled := false
	for _, task := range inspection.Tasks {
		if int64(task.Record.ConversationId) != conversationId || task.Record.Kind != "pi.tool" {
			continue
		}
		if stalledCheckpointPhase(task.Record.State.Checkpoint) == "execute" {
			stalled = true
			break
		}
	}
	if !stalled {
		return false, nil
	}
	conversation, err := resident.kernel.Harness().Conversation(ctx, durable.ConversationId(conversationId))
	if err != nil {
		return false, err
	}
	if conversation == nil {
		return false, nil
	}
	if err := conversation.Abort(ctx, nil); err != nil {
		return false, err
	}
	return true, nil
}

func stalledCheckpointPhase(checkpoint any) string {
	if checkpoint == nil {
		return ""
	}
	encoded, err := json.Marshal(checkpoint)
	if err != nil {
		return ""
	}
	var parsed map[string]any
	if json.Unmarshal(encoded, &parsed) != nil {
		return ""
	}
	phase, _ := parsed["phase"].(string)
	return phase
}

func WaitConversationIdle(ctx context.Context, database, identity string) error {
	resident, err := openResident(ctx, database)
	if err != nil {
		return err
	}
	conversationId, err := conversationIdOf(ctx, resident.kernel, identity)
	if err != nil {
		return err
	}
	if conversationId == 0 {
		return nil
	}
	conversation, err := resident.kernel.Harness().Conversation(ctx, durable.ConversationId(conversationId))
	if err != nil {
		return fmt.Errorf("pig kernel: the conversation %d is not readable: %w", conversationId, err)
	}
	if conversation == nil {
		return nil
	}
	if err := conversation.WaitForIdle(ctx); err != nil {
		return fmt.Errorf("pig kernel: the conversation %d did not become idle: %w", conversationId, err)
	}
	return nil
}

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

type ExecutionReceipt struct {
	Found bool
	Completed bool
	Status string
	Text string
	StopReason string
	Usage *Usage
}

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

func recordString(record map[string]any, name string) string {
	value, _ := record[name].(string)
	return value
}

func conversationIdFromKey(key string) (int64, bool) {
	id, err := strconv.ParseInt(key, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}
