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
	Cost     *ModelCost      `json:"cost,omitempty"`
	Pricing  *ModelPricing   `json:"pricing,omitempty"`
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
					execution := kernel.RunningExecution(graphId, nodeId)
					if execution == nil {
						Raise("invalid_adapter", "Provider send has no active execution")
					}
					frozen := limit
					if row := kernel.Execution(execution.Id); row != nil && row.TokenBudget != nil {
						frozen = row.TokenBudget
					}
					used, paused := kernel.NodeUsage(graphId, nodeId)
					task := kernel.Store.Task(graphId)
					if paused || task.Paused != 0 || phaseClosed(task.Phase) {
						Raise("paused", "Provider send is paused")
					}
					calls := kernel.PendingProviderCalls(graphId, nodeId)
					if frozen == nil || !frozen.Unlimited {
						for _, call := range calls {
							if call.State == "unknown" {
								Raise("budget", "Reconcile unknown provider usage before another send")
							}
						}
					}
					reserved := 0.0
					for _, call := range calls {
						reserved += float64(call.Reserved)
					}
					if frozen != nil && !frozen.Unlimited && float64(used)+reserved+reservation > frozen.Budget {
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
					kernel.OpenProviderCall(id, graphId, nodeId, execution.Id, reservation, modelJSON, purpose)
					return nil
				})
			}()
			return send()
		},
		Settle: func(id string, usage *TokenUsage) {
			kernel.Store.Transaction(func() any {
				call := kernel.ProviderCall(id, graphId, nodeId)
				if call == nil || call.State != "inflight" {
					Raise("invalid_adapter", "Provider call is absent or already settled")
				}
				if usage != nil {
					for _, value := range []any{usage.Input, usage.Output, usage.CacheRead, usage.CacheWrite} {
						if !isSafeInteger(value) || asFloatMust(value) < 0 {
							Raise("invalid_adapter", "Invalid provider usage")
						}
					}
				}
				state := "unknown"
				var usageJSON any
				var costJSON any
				if usage != nil {
					state = "settled"
					usageJSON = jsonStringify(usage)
					costJSON = jsonStringify(EstimateCost(*usage, call.Model.Cost, call.Model.Pricing))
				}
				kernel.SettleProviderCall(id, state, usageJSON, costJSON)
				if usage != nil {
					kernel.CommitNodeUsage(graphId, nodeId, TokenUsageTotal(*usage))
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
// ReconcileKernelUsage is explicit and idempotent. It never resumes a node.
func ReconcileKernelUsage(kernel *KernelStore, graphId, callId string, usage TokenUsage) any {
	for _, value := range []any{usage.Input, usage.Output, usage.CacheRead, usage.CacheWrite} {
		if !isSafeInteger(value) || asFloatMust(value) < 0 {
			Raise("invalid_input", "Reconciliation requires non-negative token counts")
		}
	}
	return kernel.Store.Transaction(func() any {
		call := kernel.ProviderCallOfTask(graphId, callId)
		if call == nil {
			Raise("invalid_input", "Unknown provider call")
		}
		if call.State == "reconciled" {
			if call.Usage == nil || *call.Usage != usage {
				Raise("invalid_input", "Provider usage was already reconciled differently")
			}
			return map[string]any{"replayed": true, "nodeId": call.NodeId}
		}
		if call.State != "unknown" {
			Raise("invalid_input", "Only unknown usage can be reconciled")
		}
		kernel.ReconcileProviderCall(callId, jsonStringify(usage), jsonStringify(EstimateCost(usage, call.Model.Cost, call.Model.Pricing)))
		kernel.CommitNodeUsage(graphId, call.NodeId, TokenUsageTotal(usage))
		pending := kernel.HasPendingProviderCall(graphId, call.NodeId)
		running := kernel.HasRunningExecution(graphId, call.NodeId)
		if !pending && !running {
			kernel.SettleNodeReservation(graphId, call.NodeId)
			kernel.ClearExecutionTokenReservation(graphId, call.NodeId)
		}
		task := graphId
		kernel.Store.Event(&task, "graph.provider.reconciled", map[string]any{"nodeId": call.NodeId, "callId": callId, "usage": usage})
		return map[string]any{"replayed": false, "nodeId": call.NodeId}
	})
}
