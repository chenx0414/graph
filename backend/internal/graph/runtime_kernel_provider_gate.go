package graph

import "encoding/json"

type ProviderRecipe struct {
	Definition string `json:"definition"`
	Review     bool   `json:"review"`
}

type providerCallModel struct {
	Id       string          `json:"id"`
	Identity any             `json:"identity"`
	Provider string          `json:"provider"`
	Api      string          `json:"api"`
	BaseUrl  string          `json:"baseUrl"`
	Recipe   *ProviderRecipe `json:"recipe,omitempty"`
	Cost     any             `json:"cost,omitempty"`
	Pricing  any             `json:"pricing,omitempty"`
}

// KernelProviderGate admits and charges provider sends independently of Pi turn boundaries.
func KernelProviderGate(kernel *KernelStore, graphId, nodeId string, limit *TokenBudget, model *ModelEntry, recipe *ProviderRecipe, purpose string) SendGate {
	if purpose == "" {
		purpose = "completion"
	}
	return SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			if !isSafeInteger(reservation) || reservation < 0 {
				Raise("budget", "Invalid provider reservation")
			}
			func() {
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					if re, ok := recovered.(*RuntimeError); ok {
						task := graphId
						kernel.Store.Event(&task, "graph.provider.refused", map[string]any{
							"nodeId": nodeId, "callId": id, "purpose": purpose, "code": re.Code, "reason": re.Message,
						})
					}
					panic(recovered)
				}()
				kernel.Store.Transaction(func() any {
					execution, ok := graphDBRow(kernel.Store.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1", graphId, nodeId)
					if !ok {
						Raise("invalid_adapter", "Provider send has no active execution")
					}
					frozen := limit
					if row := kernel.Execution(graphDBString(execution, "id")); row != nil && row.TokenBudget != nil {
						frozen = row.TokenBudget
					}
					state, _ := graphDBRow(kernel.Store.Db, "SELECT used,paused FROM kernel_node_state WHERE task_id=? AND node_id=?", graphId, nodeId)
					task := kernel.Store.Task(graphId)
					if graphDBInt(state, "paused") != 0 || task.Paused != 0 || phaseClosed(task.Phase) {
						Raise("paused", "Provider send is paused")
					}
					calls := graphDBAll(kernel.Store.Db, "SELECT state,reserved FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown')", graphId, nodeId)
					if frozen == nil || !frozen.Unlimited {
						for _, call := range calls {
							if graphDBString(call, "state") == "unknown" {
								Raise("budget", "Reconcile unknown provider usage before another send")
							}
						}
					}
					reserved := 0.0
					for _, call := range calls {
						reserved += float64(graphDBInt(call, "reserved"))
					}
					if frozen != nil && !frozen.Unlimited && float64(graphDBInt(state, "used"))+reserved+reservation > frozen.Budget {
						Raise("budget", "Token budget exhausted for node "+nodeId)
					}
					var modelJSON any
					if model != nil {
						recorded := providerCallModel{
							Id: model.Id, Identity: ModelIdentity(*model), Provider: model.Provider, Api: string(model.Api), BaseUrl: model.BaseUrl, Recipe: recipe,
						}
						if model.Cost != nil {
							recorded.Cost = model.Cost
						}
						if model.Pricing != nil {
							recorded.Pricing = model.Pricing
						}
						raw, err := json.Marshal(recorded)
						if err != nil {
							panic(err)
						}
						modelJSON = string(raw)
					}
					graphDBExec(kernel.Store.Db, "INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,created_at,model,purpose) VALUES(?,?,?,?,?,?,?,?,?)",
						id, graphId, nodeId, graphDBString(execution, "id"), reservation, "inflight", NowMillis(), modelJSON, purpose)
					return nil
				})
			}()
			return send()
		},
		Settle: func(id string, usage *TokenUsage) {
			kernel.Store.Transaction(func() any {
				call, ok := graphDBRow(kernel.Store.Db, "SELECT state,model FROM kernel_provider_calls WHERE id=? AND task_id=? AND node_id=?", id, graphId, nodeId)
				if !ok || graphDBString(call, "state") != "inflight" {
					Raise("invalid_adapter", "Provider call is absent or already settled")
				}
				if usage != nil {
					for _, value := range []any{usage.Input, usage.Output, usage.CacheRead, usage.CacheWrite} {
						if !isSafeInteger(value) || asFloatMust(value) < 0 {
							Raise("invalid_adapter", "Invalid provider usage")
						}
					}
				}
				var frozen frozenProviderModel
				if modelText := graphDBString(call, "model"); call["model"] != nil && modelText != "" {
					_ = json.Unmarshal([]byte(modelText), &frozen)
				}
				state := "unknown"
				var usageJSON any
				var costJSON any
				if usage != nil {
					state = "settled"
					usageJSON = jsonStringify(usage)
					costJSON = jsonStringify(EstimateCost(*usage, frozen.Cost, frozen.Pricing))
				}
				graphDBExec(kernel.Store.Db, "UPDATE kernel_provider_calls SET state=?,usage=?,cost=?,settled_at=? WHERE id=?", state, usageJSON, costJSON, NowMillis(), id)
				if usage != nil {
					graphDBExec(kernel.Store.Db, "UPDATE kernel_node_state SET used=used+? WHERE task_id=? AND node_id=?", TokenUsageTotal(*usage), graphId, nodeId)
				}
				task := graphId
				var usageValue any
				if usage != nil {
					usageValue = usage
				}
				kernel.Store.Event(&task, "graph.provider.settled", map[string]any{"nodeId": nodeId, "callId": id, "usage": usageValue})
				return nil
			})
		},
	}
}

// frozenProviderModel is the cost and pricing frozen with one provider call.
type frozenProviderModel struct {
	Cost    *ModelCost    `json:"cost"`
	Pricing *ModelPricing `json:"pricing"`
}

// ReconcileKernelUsage is explicit and idempotent. It never resumes a node.
func ReconcileKernelUsage(kernel *KernelStore, graphId, callId string, usage TokenUsage) any {
	for _, value := range []any{usage.Input, usage.Output, usage.CacheRead, usage.CacheWrite} {
		if !isSafeInteger(value) || asFloatMust(value) < 0 {
			Raise("invalid_input", "Reconciliation requires non-negative token counts")
		}
	}
	return kernel.Store.Transaction(func() any {
		call, ok := graphDBRow(kernel.Store.Db, "SELECT node_id,state,usage,model FROM kernel_provider_calls WHERE task_id=? AND id=?", graphId, callId)
		if !ok {
			Raise("invalid_input", "Unknown provider call")
		}
		if graphDBString(call, "state") == "reconciled" {
			if graphDBString(call, "usage") != jsonStringify(usage) {
				Raise("invalid_input", "Provider usage was already reconciled differently")
			}
			return map[string]any{"replayed": true, "nodeId": graphDBString(call, "node_id")}
		}
		if graphDBString(call, "state") != "unknown" {
			Raise("invalid_input", "Only unknown usage can be reconciled")
		}
		var frozen frozenProviderModel
		if call["model"] != nil && graphDBString(call, "model") != "" {
			_ = json.Unmarshal([]byte(graphDBString(call, "model")), &frozen)
		}
		graphDBExec(kernel.Store.Db, "UPDATE kernel_provider_calls SET state='reconciled',usage=?,cost=?,settled_at=? WHERE id=?",
			jsonStringify(usage), jsonStringify(EstimateCost(usage, frozen.Cost, frozen.Pricing)), NowMillis(), callId)
		graphDBExec(kernel.Store.Db, "UPDATE kernel_node_state SET used=used+? WHERE task_id=? AND node_id=?", TokenUsageTotal(usage), graphId, graphDBString(call, "node_id"))
		_, pending := graphDBRow(kernel.Store.Db, "SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown') LIMIT 1", graphId, graphDBString(call, "node_id"))
		_, running := graphDBRow(kernel.Store.Db, "SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1", graphId, graphDBString(call, "node_id"))
		if !pending && !running {
			graphDBExec(kernel.Store.Db, "UPDATE kernel_node_state SET reserved=0 WHERE task_id=? AND node_id=?", graphId, graphDBString(call, "node_id"))
			graphDBExec(kernel.Store.Db, "UPDATE kernel_executions SET token_reservation=0 WHERE task_id=? AND node_id=? AND state!='running'", graphId, graphDBString(call, "node_id"))
		}
		task := graphId
		kernel.Store.Event(&task, "graph.provider.reconciled", map[string]any{"nodeId": graphDBString(call, "node_id"), "callId": callId, "usage": usage})
		return map[string]any{"replayed": false, "nodeId": graphDBString(call, "node_id")}
	})
}
