package graph

// MAX_ROUTING_DEPTH is how deep one routing pass may cascade through module-to-module edges.
const MAX_ROUTING_DEPTH = 8

// Landing is one value that reached a node queue or another module input.
type Landing struct {
	EdgeId       string `json:"edgeId"`
	FromEndpoint string `json:"fromEndpoint"`
	ToEndpoint   string `json:"toEndpoint"`
	Kind         string `json:"kind"`
	Value        any    `json:"value"`
}

func endpointOwner(reference string) string {
	dot := stringsIndex(reference)
	if dot < 0 {
		return reference
	}
	return reference[:dot]
}

func stringsIndex(value string) int {
	for i := 0; i < len(value); i++ {
		if value[i] == '.' {
			return i
		}
	}
	return -1
}

// RouteModuleOutputs lands one module evaluation on every enabled downstream edge.
func RouteModuleOutputs(kernel *KernelStore, modules *ModuleRuntime, graphID, moduleID string, evaluation ModuleEvaluation, depth int, queueOnly bool) []Landing {
	if !evaluation.Emitted || len(evaluation.Outputs) == 0 {
		return []Landing{}
	}
	landings := []Landing{}
	deliveries := kernel.BroadcastModule(graphID, moduleID, evaluation.Outputs, evaluation.TransitionId)
	definition := kernel.LatestRevision(graphID).Definition
	for _, delivery := range deliveries {
		owner := endpointOwner(delivery.ToEndpoint)
		_, isModule := definition.Modules[owner]
		kind := "node"
		if isModule {
			kind = "module"
		}
		edgeID := ""
		if delivery.EdgeId != nil {
			edgeID = *delivery.EdgeId
		}
		landings = append(landings, Landing{
			EdgeId: edgeID, FromEndpoint: delivery.FromEndpoint, ToEndpoint: delivery.ToEndpoint,
			Kind: kind, Value: delivery.Value,
		})
		if isModule && !queueOnly && depth+1 < MAX_ROUTING_DEPTH {
			port := delivery.ToEndpoint
			if dot := stringsIndex(delivery.ToEndpoint); dot >= 0 {
				port = delivery.ToEndpoint[dot+1:]
			}
			next := modules.Deliver(owner, port, delivery.Value)
			g5Exec(kernel.Db, "UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?", delivery.Id)
			landings = append(landings, RouteModuleOutputs(kernel, modules, graphID, owner, next, depth+1, false)...)
		}
	}
	return landings
}
