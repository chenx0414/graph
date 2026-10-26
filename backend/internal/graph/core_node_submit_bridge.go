package graph

import (
	"fmt"
	"strings"

	"encoding/json"
)

// SubmitDefect is the field-level correction a model is expected to apply.
type SubmitDefect struct {
	Code     string `json:"code"`
	Path     string `json:"path"`
	Expected string `json:"expected"`
	Got      string `json:"got"`
}

type BridgeReceipt struct {
	Accepted        bool           `json:"accepted"`
	SubmissionId    *string        `json:"submissionId"`
	Replayed        bool           `json:"replayed"`
	NoRecipients    bool           `json:"noRecipients"`
	Deliveries      []DeliveryRow  `json:"deliveries"`
	Defects         []SubmitDefect `json:"defects"`
	MissingRequired []string       `json:"missingRequired"`
}

// SubmitRefusal is the structured refusal of one submission.
//
// The module that writes the delivery raises it. The bridge reads the defects
// as they were decided; it does not parse an English sentence to learn them.
type SubmitRefusal struct {
	Defects []SubmitDefect
	Missing []string
}

func (refusal *SubmitRefusal) Error() string {
	return RefusalText(refusal.Defects)
}

func refuseSubmit(defects []SubmitDefect, missing []string) {
	panic(&SubmitRefusal{Defects: defects, Missing: missing})
}

func refuseMessage(message string) {
	refuseSubmit([]SubmitDefect{{
		Code: "invalid_submit", Path: "(submission)",
		Expected: "a valid submission", Got: message,
	}}, nil)
}

func refuseMissingOutputs(names []string) {
	refuseSubmit([]SubmitDefect{{
		Code: "missing_required_output", Path: strings.Join(names, ", "),
		Expected: "enable:true", Got: "enable:false or absent",
	}}, names)
}

func submitDefectsOf(recovered any) (defects []SubmitDefect, missing []string, ok bool) {
	switch failure := recovered.(type) {
	case *SubmitRefusal:
		defects = failure.Defects
		missing = failure.Missing
		ok = true
	case *RuntimeError:
		defects = []SubmitDefect{{
			Code: failure.Code, Path: "(submission)",
			Expected: "a valid submission", Got: failure.Message,
		}}
		ok = true
	}
	if defects == nil {
		defects = []SubmitDefect{}
	}
	if missing == nil {
		missing = []string{}
	}
	return defects, missing, ok
}

// RefusalText is the short field-level refusal. The work already done stands.
func RefusalText(defects []SubmitDefect) string {
	lines := []string{"submit refused: the kernel cannot accept this submission yet."}
	for _, defect := range defects {
		lines = append(lines, fmt.Sprintf("- %s (%s): expected %s; got %s", defect.Path, defect.Code, defect.Expected, defect.Got))
	}
	lines = append(lines, "Correct these fields and submit again with the same work. Do not redo or rewrite the implementation; whatever you already wrote stays in place.")
	return strings.Join(lines, "\n")
}

type submitCall struct {
	outputs map[string]SubmitOutput
	defect  *SubmitDefect
}

// ReadSubmitCall requires exactly {"outputs": {...}}.
func ReadSubmitCall(args any) submitCall {
	record, _ := jsonRecord(args)
	if record == nil {
		record = map[string]any{}
	}
	outputs, exists := record["outputs"]
	_, isMap := jsonRecord(outputs)
	if !exists || outputs == nil || !isMap {
		sent := make([]string, 0, len(record))
		for key := range record {
			sent = append(sent, key)
		}
		path := "submit"
		if len(sent) > 0 {
			path = strings.Join(sent, ", ")
		}
		got := "a call with no outputs key"
		if exists {
			kind := fmt.Sprintf("%T", outputs)
			if _, ok := outputs.([]any); ok || outputs != nil && !isMap {
				if _, array := outputs.([]any); array {
					kind = "array"
				} else if outputs == nil {
					kind = "object"
				} else {
					kind = jsType(outputs)
				}
			}
			got = "outputs of type " + kind
		}
		if exists {
			got = "outputs of type " + jsType(outputs)
		}
		return submitCall{defect: &SubmitDefect{
			Code: "malformed_arguments", Path: path,
			Expected: `{"outputs":{"<output name>":{"enable":true,"value":<value>}}}`,
			Got:      got,
		}}
	}
	parsed := map[string]SubmitOutput{}
	for key, value := range outputs.(map[string]any) {
		item, _ := jsonRecord(value)
		enable, _ := item["enable"].(bool)
		parsed[key] = SubmitOutput{Enable: enable, Value: item["value"]}
	}
	return submitCall{outputs: parsed}
}

func jsType(value any) string {
	if value == nil {
		return "object"
	}
	switch value.(type) {
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64, int, int64, json.Number:
		return "number"
	default:
		return "object"
	}
}

// SubmitNodeCall submits one tool call against the execution that admitted it.
//
// The execution is the one the turn was frozen with. A later row for the same
// node is a different turn, and this call does not belong to it.
func SubmitNodeCall(kernel *KernelStore, executionID string, args any) (ok bool, text string) {
	if executionID == "" {
		return false, "no execution is running for this node"
	}
	call := ReadSubmitCall(args)
	if call.defect != nil {
		return false, RefusalText([]SubmitDefect{*call.defect})
	}
	receipt := NewNodeSubmitBridge(kernel, executionID).Submit(SubmitRequest{Outputs: call.outputs, SubmissionId: "v2-" + executionID})
	if receipt.Accepted {
		return true, jsonStringify(map[string]any{"accepted": true, "deliveries": len(receipt.Deliveries)})
	}
	return false, RefusalText(receipt.Defects)
}

// HostSubmitCall is the host side of one submit tool call.
//
// It addresses the latest execution of the node. A lane that already knows
// the admitted execution calls SubmitNodeCall with that execution instead.
func HostSubmitCall(kernel *KernelStore, taskId, nodeId string, args any) (ok bool, text string) {
	execution, found := graphDBRow(kernel.Store.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1", taskId, nodeId)
	if !found {
		return false, "no execution is running for this node"
	}
	return SubmitNodeCall(kernel, graphDBString(execution, "id"), args)
}

type NodeSubmitBridge struct {
	ExecutionId string
	NodeId      string
	kernel      *KernelStore
}

func NewNodeSubmitBridge(kernel *KernelStore, executionId string) *NodeSubmitBridge {
	execution := kernel.Execution(executionId)
	if execution == nil {
		Raise("invalid_submit", "Unknown execution "+executionId)
	}
	return &NodeSubmitBridge{kernel: kernel, ExecutionId: executionId, NodeId: execution.NodeId}
}

type bridgeSubmitRequest struct {
	Outputs      map[string]SubmitOutput
	SubmissionId string
}

// Submit one output set for this execution, or get the field-level correction.
func (b *NodeSubmitBridge) Submit(request SubmitRequest) BridgeReceipt {
	var receipt SubmitReceipt
	failed := false
	var defects []SubmitDefect
	var missing []string
	func() {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			parsed, gap, ok := submitDefectsOf(recovered)
			if !ok {
				panic(recovered)
			}
			failed = true
			defects = parsed
			missing = gap
		}()
		receipt = b.kernel.Submit(b.ExecutionId, request)
	}()
	if !failed {
		b.kernel.ClearExecutionMissingRequired(b.ExecutionId)
		id := receipt.SubmissionId
		return BridgeReceipt{
			Accepted: true, SubmissionId: &id, Replayed: receipt.Replayed, NoRecipients: receipt.NoRecipients,
			Deliveries: receipt.Deliveries, Defects: []SubmitDefect{}, MissingRequired: []string{},
		}
	}
	if len(missing) > 0 {
		raw, err := json.Marshal(missing)
		if err != nil {
			panic(err)
		}
		b.kernel.MarkExecutionPendingGap(b.ExecutionId, string(raw))
	}
	return BridgeReceipt{
		Accepted: false, SubmissionId: nil, Replayed: false, NoRecipients: false,
		Deliveries: []DeliveryRow{}, Defects: defects, MissingRequired: missing,
	}
}

// RefusalMessage is the refusal the node sees.
func (b *NodeSubmitBridge) RefusalMessage(receipt BridgeReceipt) string {
	if receipt.Accepted {
		Raise("invalid_submit", "There is no refusal to describe")
	}
	return RefusalText(receipt.Defects)
}
