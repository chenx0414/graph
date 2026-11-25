package graph

import (
	"math"
	"sort"

	"encoding/json"
)

type TalentSample struct {
	Kind              string             `json:"kind"`
	TaskId            string             `json:"taskId"`
	NodeId            string             `json:"nodeId"`
	InstanceId        string             `json:"instanceId"`
	DefinitionVersion *string            `json:"definitionVersion"`
	Model             *string            `json:"model"`
	Request           *string            `json:"request"`
	Status            string             `json:"status"`
	Unfinished        bool               `json:"unfinished"`
	Failed            bool               `json:"failed"`
	WaitingMs         int64              `json:"waitingMs"`
	Attempts          int                `json:"attempts"`
	ReworkRounds      int                `json:"reworkRounds"`
	Tokens            *int64             `json:"tokens"`
	RunMs             *int64             `json:"runMs"`
	Costs             map[string]float64 `json:"costs"`
	CostUnknown       bool               `json:"costUnknown"`
	StartedAt         *int64             `json:"startedAt"`
}

type MetricStat struct {
	Mean       *float64 `json:"mean"`
	Samples    int      `json:"samples"`
	Unknown    int      `json:"unknown"`
	Unfinished int      `json:"unfinished"`
	Failed     int      `json:"failed"`
}

type CurrencyStat struct {
	Mean       *float64 `json:"mean"`
	Samples    int      `json:"samples"`
	Unknown    int      `json:"unknown"`
	Unfinished int      `json:"unfinished"`
	Failed     int      `json:"failed"`
	Currency   string   `json:"currency"`
}

type TalentStats struct {
	Token MetricStat `json:"token"`
	RunMs MetricStat `json:"runMs"`
	Cost  struct {
		ByCurrency    []CurrencyStat `json:"byCurrency"`
		MixedCurrency bool           `json:"mixedCurrency"`
		Unknown       bool           `json:"unknown"`
	} `json:"cost"`
	TotalSamples int `json:"totalSamples"`
	TaskSamples  int `json:"taskSamples"`
	ChatSamples  int `json:"chatSamples"`
}

func talentMetric(samples []TalentSample, read func(TalentSample) *float64, failed func(TalentSample) bool) MetricStat {
	var finished []TalentSample
	for _, sample := range samples {
		if !sample.Unfinished {
			finished = append(finished, sample)
		}
	}
	var values []float64
	unknown := 0
	for _, sample := range finished {
		value := read(sample)
		if value == nil {
			unknown++
			continue
		}
		values = append(values, *value)
	}
	stat := MetricStat{Samples: len(values), Unknown: unknown}
	if len(values) > 0 {
		sum := 0.0
		for _, value := range values {
			sum += value
		}
		mean := sum / float64(len(values))
		stat.Mean = &mean
	}
	for _, sample := range samples {
		if sample.Unfinished {
			stat.Unfinished++
		}
	}
	for _, sample := range samples {
		if failed(sample) {
			stat.Failed++
		}
	}
	return stat
}

type TalentExperience struct {
	Scope struct {
		Version     *int `json:"version"`
		AllVersions bool `json:"allVersions"`
	} `json:"scope"`
	Samples []TalentSample `json:"samples"`
	Task    TalentStats    `json:"task"`
	Chat    TalentStats    `json:"chat"`
	All     TalentStats    `json:"all"`
}

func TalentExperienceOf(store *TaskStore, id string, version *int, allVersions bool) TalentExperience {
	latest, _ := g5One(store.Db, "SELECT MAX(version) AS version FROM definitions WHERE id=?", id)
	var scopeVersion *int
	if !allVersions {
		if version != nil {
			scopeVersion = version
		} else if latest["version"] != nil {
			value := int(g5Int(latest["version"]))
			scopeVersion = &value
		}
	}
	like := id + "@%"
	clause := "LIKE ?"
	if version != nil && !allVersions {
	}
	if version != nil {
		clause = "=?"
		like = id + "@" + talentItoa(int64(*version))
	}
	rows := g5Query(store.Db, `SELECT i.id AS instance_id, i.definition_version, i.model, i.used,
    n.task_id, n.id AS node_id, n.status, n.spec,
    t.phase, t.created_seq, t.request
    FROM instances i JOIN nodes n ON n.instance_id=i.id JOIN tasks t ON t.id=n.task_id
    WHERE i.definition_version `+clause+`
    ORDER BY t.created_seq, n.rowid`, like)
	samples := []TalentSample{}
	for _, row := range rows {
		spec, _ := g5JSON(row["spec"]).(map[string]any)
		invocations := g5Query(store.Db, "SELECT usage,cost FROM invocations WHERE instance_id=? ORDER BY rowid", row["instance_id"])
		operations := g5Query(store.Db, "SELECT state,dispatched_at,settled_at,waiting_ms FROM operations WHERE instance_id=? ORDER BY rowid", row["instance_id"])
		status := g5Str(row["status"])
		finished := status == "succeeded" || status == "skipped" || status == "retired"
		unsuccessful := status == "failed" || status == "blocked"
		usageKnown := len(invocations) > 0
		var tokensSum int64
		for _, invocation := range invocations {
			if invocation["usage"] == nil {
				usageKnown = false
				break
			}
		}
		var tokens *int64
		if usageKnown {
			for _, invocation := range invocations {
				var usage TokenUsage
				if err := json.Unmarshal([]byte(g5Str(invocation["usage"])), &usage); err != nil {
					panic(err)
				}
				tokensSum += TokenUsageTotal(usage)
			}
			tokens = &tokensSum
		}
		var waiting int64
		attempts := 0
		timingsKnown := len(operations) > 0
		var run int64
		for _, operation := range operations {
			waiting += g5Int(operation["waiting_ms"])
			if g5Str(operation["state"]) == "succeeded" {
				attempts++
			}
			if operation["dispatched_at"] == nil || operation["settled_at"] == nil {
				timingsKnown = false
				continue
			}
			delta := g5Int(operation["settled_at"]) - g5Int(operation["dispatched_at"]) - g5Int(operation["waiting_ms"])
			if delta < 0 {
				delta = 0
			}
			run += delta
		}
		var runMs *int64
		if timingsKnown {
			runMs = &run
		}
		costs := map[string]float64{}
		costUnknown := false
		for _, invocation := range invocations {
			if invocation["cost"] == nil {
				costUnknown = true
				continue
			}
			parsed, _ := g5JSON(invocation["cost"]).(map[string]any)
			amount, ok := parsed["amount"].(float64)
			if parsed["unknown"] == true || !ok || math.IsNaN(amount) || math.IsInf(amount, 0) {
				costUnknown = true
				continue
			}
			currency, _ := parsed["currency"].(string)
			if currency == "" {
				currency = "?"
			}
			costs[currency] += amount
		}
		kind := "task"
		if g5Str(spec["role"]) == "master" {
			kind = "chat"
		}
		sample := TalentSample{
			Kind: kind, TaskId: g5Str(row["task_id"]), NodeId: g5Str(row["node_id"]), InstanceId: g5Str(row["instance_id"]),
			Status: status, Unfinished: !finished, Failed: unsuccessful, WaitingMs: waiting,
			Attempts: attempts, ReworkRounds: attempts - 1, Tokens: tokens, RunMs: runMs, Costs: costs, CostUnknown: costUnknown,
		}
		if sample.ReworkRounds < 0 {
			sample.ReworkRounds = 0
		}
		if row["definition_version"] != nil {
			text := g5Str(row["definition_version"])
			sample.DefinitionVersion = &text
		}
		if row["model"] != nil {
			text := g5Str(row["model"])
			sample.Model = &text
		}
		if row["request"] != nil {
			text := g5Str(row["request"])
			sample.Request = &text
		}
		samples = append(samples, sample)
	}
	var task, chat []TalentSample
	for _, sample := range samples {
		if sample.Kind == "task" {
			task = append(task, sample)
		} else {
			chat = append(chat, sample)
		}
	}
	if task == nil {
		task = []TalentSample{}
	}
	if chat == nil {
		chat = []TalentSample{}
	}
	out := TalentExperience{Samples: samples, Task: talentStats(task), Chat: talentStats(chat), All: talentStats(samples)}
	out.Scope.Version = scopeVersion
	out.Scope.AllVersions = scopeVersion == nil
	return out
}

func talentStats(list []TalentSample) TalentStats {
	currencies := map[string]bool{}
	for _, sample := range list {
		for currency := range sample.Costs {
			currencies[currency] = true
		}
	}
	names := sortedKeys(currencies)
	sort.Strings(names)
	var finished []TalentSample
	for _, sample := range list {
		if !sample.Unfinished {
			finished = append(finished, sample)
		}
	}
	byCurrency := []CurrencyStat{}
	for _, currency := range names {
		var values []float64
		unknown := 0
		failed := 0
		for _, sample := range finished {
			amount, ok := sample.Costs[currency]
			if !ok {
				continue
			}
			values = append(values, amount)
			if sample.CostUnknown {
				unknown++
			}
			if sample.Failed {
				failed++
			}
		}
		unfinished := 0
		for _, sample := range list {
			if _, ok := sample.Costs[currency]; ok && sample.Unfinished {
				unfinished++
			}
		}
		stat := CurrencyStat{Currency: currency, Samples: len(values), Unknown: unknown, Unfinished: unfinished, Failed: failed}
		if len(values) > 0 {
			sum := 0.0
			for _, value := range values {
				sum += value
			}
			mean := sum / float64(len(values))
			stat.Mean = &mean
		}
		byCurrency = append(byCurrency, stat)
	}
	unknown := false
	for _, sample := range finished {
		if sample.CostUnknown {
			unknown = true
		}
	}
	stats := TalentStats{
		Token: talentMetric(list, func(sample TalentSample) *float64 {
			if sample.Tokens == nil {
				return nil
			}
			value := float64(*sample.Tokens)
			return &value
		}, func(sample TalentSample) bool { return sample.Failed }),
		RunMs: talentMetric(list, func(sample TalentSample) *float64 {
			if sample.RunMs == nil {
				return nil
			}
			value := float64(*sample.RunMs)
			return &value
		}, func(sample TalentSample) bool { return sample.Failed }),
		TotalSamples: len(list),
	}
	stats.Cost.ByCurrency = byCurrency
	stats.Cost.MixedCurrency = len(names) > 1
	stats.Cost.Unknown = unknown
	for _, sample := range list {
		if sample.Kind == "task" {
			stats.TaskSamples++
		}
		if sample.Kind == "chat" {
			stats.ChatSamples++
		}
	}
	return stats
}

func TalentDetail(store *TaskStore, id string, version *int, capability func(id, version string) *CapabilityRecord) map[string]any {
	rows := g5Query(store.Db, "SELECT version,spec FROM definitions WHERE id=? ORDER BY version", id)
	type versionSpec struct {
		Version int
		Spec    map[string]any
	}
	var versions []versionSpec
	for _, row := range rows {
		spec, _ := g5JSON(row["spec"]).(map[string]any)
		versions = append(versions, versionSpec{Version: int(g5Int(row["version"])), Spec: spec})
	}
	if len(versions) == 0 {
		Raise("not_found", "Unknown Agent definition "+id)
	}
	chosen := versions[len(versions)-1]
	if version != nil {
		found := false
		for _, item := range versions {
			if item.Version == *version {
				chosen = item
				found = true
			}
		}
		if !found {
			Raise("not_found", "Definition "+id+"@"+talentItoa(int64(*version))+" is not published")
		}
	}
	capabilities := []any{}
	if list, ok := chosen.Spec["capabilities"].([]any); ok {
		for _, bound := range list {
			item, _ := bound.(map[string]any)
			record := capabilityRecord(capability, g5Str(item["id"]), g5Str(item["version"]))
			capabilities = append(capabilities, map[string]any{
				"id": item["id"], "version": item["version"], "kind": recordKind(record), "status": recordStatus(record), "source": recordSource(record),
			})
		}
	}
	prompts := []any{}
	if promptMap, ok := chosen.Spec["prompts"].(map[string]any); ok {
		for _, role := range sortedKeys(promptMap) {
			bound, _ := promptMap[role].(map[string]any)
			if bound == nil {
				continue
			}
			record := capabilityRecord(capability, g5Str(bound["id"]), g5Str(bound["version"]))
			prompts = append(prompts, map[string]any{
				"id": bound["id"], "version": bound["version"], "role": role,
				"kind": recordKind(record), "status": recordStatus(record), "source": recordSource(record),
			})
		}
	}
	var description any
	trace := map[string]any{"origin": "user"}
	if preset := capabilityConfigObject(chosen.Spec["snapshot"]); preset != nil {
		if preset["description"] != nil {
			description = preset["description"]
		}
		if origin, ok := preset["preset"].(map[string]any); ok && origin != nil {
			trace = map[string]any{"origin": "preset"}
			for key, value := range origin {
				trace[key] = value
			}
		}
	}
	review, _ := chosen.Spec["review"].(bool)
	versionNumbers := []int{}
	for _, item := range versions {
		versionNumbers = append(versionNumbers, item.Version)
	}
	return map[string]any{
		"id": id, "version": chosen.Version, "versions": versionNumbers,
		"review":      review,
		"description": description, "traceability": trace, "capabilities": capabilities, "prompts": prompts,
	}
}

func capabilityRecord(capability func(id, version string) *CapabilityRecord, id, version string) *CapabilityRecord {
	if capability == nil {
		return nil
	}
	return capability(id, version)
}

func recordKind(record *CapabilityRecord) any {
	if record == nil || record.Kind == "" {
		return nil
	}
	return record.Kind
}

func recordStatus(record *CapabilityRecord) any {
	if record == nil || record.Status == "" {
		return "missing"
	}
	return record.Status
}

func recordSource(record *CapabilityRecord) any {
	if record == nil || record.Source == "" {
		return nil
	}
	return record.Source
}

func talentItoa(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}
