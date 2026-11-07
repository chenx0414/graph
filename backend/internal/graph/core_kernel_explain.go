package graph

import (
	"sort"
	"strings"

	"errors"
)

type InputExplanation struct {
	Name           string  `json:"name"`
	Protocol       string  `json:"protocol"`
	Delivered      bool    `json:"delivered"`
	Missing        bool    `json:"missing"`
	Value          any     `json:"value"`
	ValueTruncated bool    `json:"valueTruncated"`
	ValueBytes     int64   `json:"valueBytes"`
	ValuePreview   *string `json:"valuePreview"`
	Source         *string `json:"source"`
	UpdatedAt      *int64  `json:"updatedAt"`
}

type TransitionExplanation struct {
	Cursor           int64   `json:"cursor"`
	ID               string  `json:"id"`
	InputName        string  `json:"inputName"`
	InputValue       any     `json:"inputValue"`
	StateBefore      any     `json:"stateBefore"`
	StateAfter       any     `json:"stateAfter"`
	Verdict          *string `json:"verdict"`
	Outputs          any     `json:"outputs"`
	RuleVersion      int64   `json:"ruleVersion"`
	Reason           string  `json:"reason"`
	CreatedAt        int64   `json:"createdAt"`
	PayloadTruncated bool    `json:"payloadTruncated"`
	PayloadBytes     int64   `json:"payloadBytes"`
	PayloadPreview   *string `json:"payloadPreview"`
}

type ModuleExplanation struct {
	ModuleID         string                  `json:"moduleId"`
	Type             string                  `json:"type"`
	Trigger          string                  `json:"trigger"`
	Triggered        bool                    `json:"triggered"`
	State            any                     `json:"state"`
	StateTruncated   bool                    `json:"stateTruncated"`
	StateBytes       int64                   `json:"stateBytes"`
	StatePreview     *string                 `json:"statePreview"`
	RuleVersion      int64                   `json:"ruleVersion"`
	LatestTransition *int64                  `json:"latestTransition"`
	NextAfter        *int64                  `json:"nextAfter"`
	Inputs           []InputExplanation      `json:"inputs"`
	Transitions      []TransitionExplanation `json:"transitions"`
}

type EdgeDeliveryExplanation struct {
	ID                string           `json:"id"`
	Value             any              `json:"value"`
	Protocol          string           `json:"protocol"`
	Seq               int64            `json:"seq"`
	ValueTruncated    bool             `json:"valueTruncated"`
	ValueBytes        int64            `json:"valueBytes"`
	ValuePreview      *string          `json:"valuePreview"`
	RevisionVersion   int64            `json:"revisionVersion"`
	CreatedAt         int64            `json:"createdAt"`
	Source            string           `json:"source"`
	SourceExecutionID *string          `json:"sourceExecutionId"`
	Artifacts         []ArtifactRefHit `json:"artifacts"`
	Receiver          EdgeReceiver     `json:"receiver"`
}

type ArtifactRefHit struct {
	TaskID     string  `json:"taskId"`
	ArtifactID string  `json:"artifactId"`
	Version    int64   `json:"version"`
	Digest     *string `json:"digest"`
}

type EdgeReceiver struct {
	Kind        string  `json:"kind"`
	State       string  `json:"state"`
	OperationID *string `json:"operationId"`
	Reason      *string `json:"reason"`
}

type EdgeExplanation struct {
	EdgeID          string                    `json:"edgeId"`
	From            string                    `json:"from"`
	To              string                    `json:"to"`
	Enabled         bool                      `json:"enabled"`
	Protocol        *string                   `json:"protocol"`
	Latest          any                       `json:"latest"`
	LatestTruncated bool                      `json:"latestTruncated"`
	NextBefore      *int64                    `json:"nextBefore"`
	Deliveries      []EdgeDeliveryExplanation `json:"deliveries"`
}

type ModuleHistoryQuery struct {
	After              any
	Limit              any
	TransitionID       *string
	FullValues         bool
	IncludeTransitions *bool
}

type EdgeHistoryQuery struct {
	Before     any
	Limit      any
	DeliveryID *string
	FullValue  bool
}

func explainCompact(column string, full bool) string {
	flag := "0"
	if full {
		flag = "1"
	}
	return "CASE WHEN " + flag + " OR " + ContentColumn(column, "bytes") + "<=4096 THEN " + ContentColumn(column) + " ELSE NULL END"
}

func explainPreview(column string, full bool) string {
	flag := "0"
	if full {
		flag = "1"
	}
	return "CASE WHEN NOT " + flag + " AND " + ContentColumn(column, "bytes") + ">4096 THEN " + ContentColumn(column, "preview") + " ELSE NULL END"
}

func explainOptionalString(value any) *string {
	if value == nil {
		return nil
	}
	text := kernelString(value)
	return &text
}

func explainOptionalInt(value any) *int64 {
	if value == nil {
		return nil
	}
	n := kernelInt(value)
	return &n
}

func explainParsed(value any) any {
	if value == nil {
		return nil
	}
	text := kernelString(value)
	if text == "" && value == nil {
		return nil
	}
	return parseJSON(text)
}

func artifactReferences(taskID string, value any) []ArtifactRefHit {
	found := []ArtifactRefHit{}
	seen := map[string]bool{}
	pending := []any{value}
	for len(pending) > 0 {
		item := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if item == nil {
			continue
		}
		if list := asSlice(item); list != nil {
			for _, child := range list {
				pending = append(pending, child)
			}
			continue
		}
		record := asMap(item)
		if record == nil {
			continue
		}
		artifactID, _ := record["artifactId"].(string)
		version, versionOK := record["version"].(float64)
		if artifactID != "" && versionOK && jsSafeInteger(version) && version > 0 {
			var digest *string
			if text, ok := record["digest"].(string); ok {
				digest = &text
			}
			key := artifactID + ":" + itoa(int(version))
			if !seen[key] {
				seen[key] = true
				found = append(found, ArtifactRefHit{TaskID: taskID, ArtifactID: artifactID, Version: int64(version), Digest: digest})
			}
		}
		keys := make([]string, 0, len(record))
		for key := range record {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			pending = append(pending, record[key])
		}
	}
	return found
}

func explainLimit(value any, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return sqlFloat(value)
}

func ExplainModule(kernel *KernelStore, taskID, moduleID string, query ModuleHistoryQuery) ModuleExplanation {
	after := explainLimit(query.After, 0)
	limit := explainLimit(query.Limit, 20)
	if !jsSafeInteger(after) || after < 0 || !jsSafeInteger(limit) || limit < 1 || limit > 200 {
		Raise("invalid_query", "Module history requires a non-negative after cursor and a limit from 1 to 200")
	}
	full := query.FullValues
	moduleRow := kernelRow(kernel.DB, `SELECT module_type,trigger,rule_version,triggered,
    `+explainCompact("state", full)+` AS content,`+ContentColumn("state", "bytes")+` AS bytes,
    `+explainPreview("state", full)+` AS preview
    FROM kernel_modules WHERE task_id=? AND module_id=?`, taskID, moduleID)
	if moduleRow == nil {
		Raise("invalid_module", "Unknown module "+taskID+"/"+moduleID)
	}
	declared := map[string]ProtocolRef{}
	if latest := kernel.LatestRevision(taskID); latest != nil {
		if module, ok := latest.Definition.Modules[moduleID]; ok {
			declared = module.Inputs
		}
	}
	names := sortedKeys(declared)
	inputs := []InputExplanation{}
	for _, name := range names {
		spec := declared[name]
		row := kernelRow(kernel.DB, `SELECT delivered,source,updated_at,`+explainCompact("value", full)+` AS content,
      `+ContentColumn("value", "bytes")+` AS bytes,
      `+explainPreview("value", full)+` AS preview
      FROM kernel_module_inputs WHERE task_id=? AND module_id=? AND name=?`, taskID, moduleID, name)
		delivered := row != nil && kernelInt(row["delivered"]) == 1
		var value any
		truncated := false
		bytes := int64(0)
		var preview *string
		var source *string
		var updated *int64
		if row != nil {
			bytes = kernelInt(row["bytes"])
			preview = explainOptionalString(row["preview"])
			source = explainOptionalString(row["source"])
			updated = explainOptionalInt(row["updated_at"])
			if delivered && row["content"] != nil {
				value = explainParsed(row["content"])
			}
			truncated = delivered && row["content"] == nil && bytes > 4096
		}
		inputs = append(inputs, InputExplanation{
			Name: name, Protocol: spec.Protocol, Delivered: delivered, Missing: !delivered,
			Value: value, ValueTruncated: truncated, ValueBytes: bytes, ValuePreview: preview,
			Source: source, UpdatedAt: updated,
		})
	}
	payloadFields := []string{"input_value", "state_before", "state_after", "outputs"}
	fullTransition := query.TransitionID != nil && *query.TransitionID != ""
	selects := []string{}
	for _, column := range payloadFields {
		selects = append(selects, explainCompact(column, fullTransition)+" AS "+column)
	}
	byteSum := []string{}
	for _, column := range payloadFields {
		byteSum = append(byteSum, ContentColumn(column, "bytes"))
	}
	rows := []map[string]any{}
	if query.IncludeTransitions == nil || *query.IncludeTransitions {
		var transition any
		if query.TransitionID != nil {
			transition = *query.TransitionID
		}
		rows = kernelRows(kernel.DB, `SELECT rowid AS cursor,id,input_name,verdict,rule_version,reason,created_at,
      `+strings.Join(selects, ",")+`,
      `+strings.Join(byteSum, "+")+` AS bytes,
      `+ContentColumn("input_value", "preview")+` AS preview
      FROM kernel_module_transitions WHERE task_id=? AND module_id=? AND rowid>? AND (? IS NULL OR id=?) ORDER BY rowid LIMIT ?`,
			taskID, moduleID, int64(after), transition, transition, int64(limit)+1)
	}
	if query.TransitionID != nil && *query.TransitionID != "" && len(rows) == 0 {
		Raise("invalid_transition", "Transition does not belong to this graph module")
	}
	shown := rows
	if len(shown) > int(limit) {
		shown = shown[:int(limit)]
	}
	transitions := []TransitionExplanation{}
	for _, row := range shown {
		truncated := false
		for _, column := range payloadFields {
			if row[column] == nil {
				truncated = true
			}
		}
		outputs := any(map[string]any{})
		if row["outputs"] != nil {
			outputs = explainParsed(row["outputs"])
		}
		var preview *string
		if truncated {
			preview = explainOptionalString(row["preview"])
		}
		transitions = append(transitions, TransitionExplanation{
			Cursor: kernelInt(row["cursor"]), ID: kernelString(row["id"]), InputName: kernelString(row["input_name"]),
			InputValue: explainParsed(row["input_value"]), StateBefore: explainParsed(row["state_before"]), StateAfter: explainParsed(row["state_after"]),
			Verdict: explainOptionalString(row["verdict"]), Outputs: outputs, RuleVersion: kernelInt(row["rule_version"]),
			Reason: kernelString(row["reason"]), CreatedAt: kernelInt(row["created_at"]),
			PayloadTruncated: truncated, PayloadBytes: kernelInt(row["bytes"]), PayloadPreview: preview,
		})
	}
	latest := kernelRow(kernel.DB, "SELECT MAX(rowid) AS cursor FROM kernel_module_transitions WHERE task_id=? AND module_id=?", taskID, moduleID)
	var latestCursor *int64
	if latest != nil {
		latestCursor = explainOptionalInt(latest["cursor"])
	}
	var nextAfter *int64
	if len(rows) > int(limit) && len(transitions) > 0 {
		cursor := transitions[len(transitions)-1].Cursor
		nextAfter = &cursor
	}
	state := any(nil)
	if moduleRow["content"] != nil {
		state = explainParsed(moduleRow["content"])
	}
	return ModuleExplanation{
		ModuleID: moduleID, Type: kernelString(moduleRow["module_type"]), Trigger: kernelString(moduleRow["trigger"]),
		Triggered: kernelInt(moduleRow["triggered"]) == 1, State: state, StateTruncated: moduleRow["content"] == nil,
		StateBytes: kernelInt(moduleRow["bytes"]), StatePreview: explainOptionalString(moduleRow["preview"]),
		RuleVersion: kernelInt(moduleRow["rule_version"]), LatestTransition: latestCursor, NextAfter: nextAfter,
		Inputs: inputs, Transitions: transitions,
	}
}

func ExplainEdge(kernel *KernelStore, taskID, edgeID string, revisionVersion *int, query EdgeHistoryQuery) EdgeExplanation {
	var revision = kernel.LatestRevision(taskID)
	if revisionVersion != nil {
		revision = kernel.Revision(taskID, *revisionVersion)
	}
	var edge EdgeDefinition
	ok := false
	if revision != nil {
		edge, ok = revision.Definition.Edges[edgeID]
	}
	if !ok {
		panic(errors.New("Unknown edge " + taskID + "/" + edgeID))
	}
	var protocol *string
	if strings.Contains(edge.To, ".") {
		parts := strings.Split(edge.To, ".")
		id := parts[0]
		port := strings.Join(parts[1:], ".")
		var inputs map[string]ProtocolRef
		if node, found := revision.Definition.Nodes[id]; found {
			inputs = node.Inputs
		} else if module, found := revision.Definition.Modules[id]; found {
			inputs = module.Inputs
		}
		if ref, found := inputs[port]; found {
			text := ref.Protocol
			protocol = &text
		}
	}
	limit := explainLimit(query.Limit, 20)
	if !jsSafeInteger(limit) || limit < 1 || limit > 200 || (query.Before != nil && (!jsSafeInteger(query.Before) || sqlFloat(query.Before) < 1)) {
		Raise("invalid_query", "Edge history requires a positive before cursor and a limit from 1 to 200")
	}
	fullFlag := 0
	if query.FullValue {
		fullFlag = 1
	}
	var before any
	if query.Before != nil {
		before = query.Before
	}
	var delivery any
	if query.DeliveryID != nil {
		delivery = *query.DeliveryID
	}
	rows := kernelRows(kernel.DB, `SELECT id,submission_id AS submissionId,protocol,seq,source,
    revision_version AS revisionVersion,created_at AS createdAt,
    `+ContentColumn("value", "bytes")+` AS valueBytes,
    CASE WHEN ? OR `+ContentColumn("value", "bytes")+`<=4096 THEN `+ContentColumn("value")+` ELSE NULL END AS content,
    CASE WHEN NOT ? AND `+ContentColumn("value", "bytes")+`>4096 THEN `+ContentColumn("value", "preview")+` ELSE NULL END AS valuePreview
    FROM kernel_deliveries WHERE task_id=? AND edge_id=? AND (? IS NULL OR seq<?)
    AND (? IS NULL OR id=?) ORDER BY seq DESC LIMIT ?`,
		fullFlag, fullFlag, taskID, edgeID, before, before, delivery, delivery, int64(limit)+1)
	if query.DeliveryID != nil && *query.DeliveryID != "" && len(rows) == 0 {
		Raise("invalid_delivery", "Delivery does not belong to this graph edge")
	}
	shown := rows
	if len(shown) > int(limit) {
		shown = shown[:int(limit)]
	}
	var newest map[string]any
	if query.Before != nil || (query.DeliveryID != nil && *query.DeliveryID != "") {
		newest = kernelRow(kernel.DB, `SELECT CASE WHEN `+ContentColumn("value", "bytes")+`<=4096 THEN `+ContentColumn("value")+` ELSE NULL END AS content
      FROM kernel_deliveries WHERE task_id=? AND edge_id=? ORDER BY seq DESC LIMIT 1`, taskID, edgeID)
	} else if len(shown) > 0 {
		newest = shown[0]
	}
	var latest any
	latestTruncated := newest != nil && newest["content"] == nil
	if newest != nil && newest["content"] != nil && kernelString(newest["content"]) != "" {
		latest = explainParsed(newest["content"])
	}
	deliveries := []EdgeDeliveryExplanation{}
	for _, row := range shown {
		var execution *string
		if row["submissionId"] != nil {
			submission := kernelRow(kernel.DB, "SELECT execution_id FROM kernel_submissions WHERE task_id=? AND id=?", taskID, row["submissionId"])
			if submission != nil {
				execution = explainOptionalString(submission["execution_id"])
			}
		}
		queue := kernelRow(kernel.DB, `SELECT state,reason FROM kernel_queue WHERE task_id=? AND kind='delivery' AND json_extract(`+ContentColumn("payload")+`,'$.deliveryId')=? ORDER BY seq DESC LIMIT 1`, taskID, row["id"])
		inbox := kernelRow(kernel.DB, "SELECT processed FROM kernel_module_inbox WHERE task_id=? AND delivery_id=?", taskID, row["id"])
		operation := kernelRow(kernel.DB, "SELECT id,state,error FROM kernel_module_operations WHERE task_id=? AND delivery_id=?", taskID, row["id"])
		value := explainParsed(row["content"])
		receiver := EdgeReceiver{Kind: "unknown", State: "accepted"}
		if queue != nil {
			receiver = EdgeReceiver{Kind: "node", State: kernelString(queue["state"]), Reason: explainOptionalString(queue["reason"])}
		} else if inbox != nil {
			state := "queued"
			if kernelInt(inbox["processed"]) != 0 {
				state = "processed"
			}
			var operationID *string
			var reason *string
			if operation != nil {
				if operation["state"] != nil {
					state = kernelString(operation["state"])
				}
				operationID = explainOptionalString(operation["id"])
				reason = explainOptionalString(operation["error"])
			}
			receiver = EdgeReceiver{Kind: "module", State: state, OperationID: operationID, Reason: reason}
		}
		deliveries = append(deliveries, EdgeDeliveryExplanation{
			ID: kernelString(row["id"]), Value: value, Protocol: kernelString(row["protocol"]), Seq: kernelInt(row["seq"]),
			ValueTruncated: row["content"] == nil, ValueBytes: kernelInt(row["valueBytes"]), ValuePreview: explainOptionalString(row["valuePreview"]),
			RevisionVersion: kernelInt(row["revisionVersion"]), CreatedAt: kernelInt(row["createdAt"]),
			Source: kernelString(row["source"]), SourceExecutionID: execution, Artifacts: artifactReferences(taskID, value), Receiver: receiver,
		})
	}
	var nextBefore *int64
	if len(rows) > int(limit) && len(deliveries) > 0 {
		seq := deliveries[len(deliveries)-1].Seq
		nextBefore = &seq
	}
	return EdgeExplanation{
		EdgeID: edgeID, From: edge.From, To: edge.To, Enabled: edge.Enabled, Protocol: protocol,
		Latest: latest, LatestTruncated: latestTruncated, NextBefore: nextBefore, Deliveries: deliveries,
	}
}
