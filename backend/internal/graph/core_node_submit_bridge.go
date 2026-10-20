package graph

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
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

func classifySubmit(err *RuntimeError) (defects []SubmitDefect, missingRequired []string) {
	message := err.Message
	if match := regexp.MustCompile(`^Required output\(s\) not enabled: (.+)$`).FindStringSubmatch(message); match != nil {
		parts := splitTrim(match[1])
		return []SubmitDefect{{Code: "missing_required_output", Path: strings.Join(parts, ", "), Expected: "enable:true", Got: "enable:false or absent"}}, parts
	}
	if match := regexp.MustCompile(`^Output (\S+) does not satisfy (\S+): (.+)$`).FindStringSubmatch(message); match != nil {
		return []SubmitDefect{{Code: "output_protocol_mismatch", Path: match[1], Expected: match[2] + ": " + match[3], Got: "the value you sent"}}, []string{}
	}
	if match := regexp.MustCompile(`^Node \S+ has no output (\S+)$`).FindStringSubmatch(message); match != nil {
		return []SubmitDefect{{Code: "unknown_output", Path: match[1], Expected: "a declared output of this node", Got: match[1]}}, []string{}
	}
	if match := regexp.MustCompile(`^Delivery (\S+) to (\S+) does not satisfy (\S+): (.+)$`).FindStringSubmatch(message); match != nil {
		return []SubmitDefect{{Code: "target_protocol_mismatch", Path: match[2], Expected: match[3] + ": " + match[4], Got: "the value the edge would carry"}}, []string{}
	}
	if match := regexp.MustCompile(`^Execution (\S+) already submitted`).FindStringSubmatch(message); match != nil {
		return []SubmitDefect{{Code: "already_submitted", Path: match[1], Expected: "one valid submission per execution", Got: "a second, different submission"}}, []string{}
	}
	if match := regexp.MustCompile(`^Execution (\S+) is (\S+)`).FindStringSubmatch(message); match != nil {
		return []SubmitDefect{{Code: "execution_not_running", Path: match[1], Expected: "a running execution", Got: match[2]}}, []string{}
	}
	return []SubmitDefect{{Code: err.Code, Path: "(submission)", Expected: "a valid submission", Got: message}}, []string{}
}

func splitTrim(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, strings.TrimSpace(part))
	}
	return out
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

// HostSubmitCall is the host side of one submit tool call.
func HostSubmitCall(kernel *KernelStore, taskId, nodeId string, args any) (ok bool, text string) {
	execution, found := graphDBRow(kernel.Store.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1", taskId, nodeId)
	if !found {
		return false, "no execution is running for this node"
	}
	call := ReadSubmitCall(args)
	if call.defect != nil {
		return false, RefusalText([]SubmitDefect{*call.defect})
	}
	receipt := NewNodeSubmitBridge(kernel, graphDBString(execution, "id")).Submit(SubmitRequest{Outputs: call.outputs, SubmissionId: "v2-" + graphDBString(execution, "id")})
	if receipt.Accepted {
		return true, jsonStringify(map[string]any{"accepted": true, "deliveries": len(receipt.Deliveries)})
	}
	return false, RefusalText(receipt.Defects)
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
	var caught *RuntimeError
	func() {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			re, ok := recovered.(*RuntimeError)
			if !ok {
				panic(recovered)
			}
			failed = true
			caught = re
		}()
		receipt = b.kernel.Submit(b.ExecutionId, request)
	}()
	if !failed {
		graphDBExec(b.kernel.Store.Db, "UPDATE kernel_executions SET missing_required=0 WHERE id=?", b.ExecutionId)
		id := receipt.SubmissionId
		return BridgeReceipt{
			Accepted: true, SubmissionId: &id, Replayed: receipt.Replayed, NoRecipients: receipt.NoRecipients,
			Deliveries: receipt.Deliveries, Defects: []SubmitDefect{}, MissingRequired: []string{},
		}
	}
	defects, missing := classifySubmit(caught)
	if len(missing) > 0 {
		raw, err := json.Marshal(missing)
		if err != nil {
			panic(err)
		}
		graphDBExec(b.kernel.Store.Db, "UPDATE kernel_executions SET missing_required=1,pending_gap=? WHERE id=?", string(raw), b.ExecutionId)
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
