package graph

import (
	"net/http"
)

func (app *GraphApp) serveNodeMessage(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := NodeMessageInput{
		Text:      appBodyString(body, "text"),
		RequestID: appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.SendNodeMessage(r.PathValue("taskId"), r.PathValue("nodeId"), input))
}

func (app *GraphApp) serveNodeRun(w http.ResponseWriter, r *http.Request) {
	query := NodeEntryQuery{}
	if value, ok := appQueryNumber(r, "after"); ok {
		query.After = &value
	}
	if value, ok := appQueryNumber(r, "before"); ok {
		query.Before = &value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = &value
	}
	if entry := r.URL.Query().Get("entryId"); entry != "" {
		query.EntryID = &entry
	}
	writeJSON(w, http.StatusOK, app.runtime.NodeRun(r.PathValue("taskId"), r.PathValue("nodeId"), query))
}

func (app *GraphApp) serveNodePrompt(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.NodePrompt(r.PathValue("taskId"), r.PathValue("nodeId")))
}

func (app *GraphApp) serveOperations(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()
	query := OperationQuery{Latest: values.Get("latest") == "true"}
	if value := values.Get("after"); value != "" {
		query.After = &value
	}
	if value := values.Get("before"); value != "" {
		query.Before = &value
	}
	if value := values.Get("nodeId"); value != "" {
		query.NodeId = &value
	}
	limit := 50
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	query.Limit = &limit
	writeJSON(w, http.StatusOK, app.runtime.Operations(r.PathValue("taskId"), query))
}

func (app *GraphApp) serveGraphCreate(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	conversationId := appBodyString(body, "conversationId")
	if conversationId == "" {
		RaiseStatus(http.StatusBadRequest, "invalid_input", "The request must name the conversation that owns the graph")
	}
	payload := map[string]any{"definition": body["definition"]}
	if value, ok := body["targetBranch"].(string); ok && value != "" {
		payload["targetBranch"] = value
	}
	if value, ok := body["requestId"].(string); ok && value != "" {
		payload["requestId"] = value
	}
	writeJSON(w, http.StatusOK, app.runtime.CreateGraph(conversationId, payload))
}

func (app *GraphApp) serveGraphControl(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := GraphControlInput{
		Action: appBodyString(body, "action"), RequestID: appBodyString(body, "requestId"), Text: appBodyString(body, "text"), Proof: appBodyString(body, "proof"),
	}
	if value, ok := body["operationId"].(string); ok {
		input.OperationId = &value
	}
	if value, ok := body["callId"].(string); ok {
		input.CallId = &value
	}
	if value, ok := body["usage"].(map[string]any); ok {
		keys := []string{"input", "output", "cacheRead", "cacheWrite"}
		values := make([]int, len(keys))
		for index, key := range keys {
			if !isSafeInteger(value[key]) {
				Raise("invalid_input", "usage requires non-negative integer token counts")
			}
			number, valid := appBodyInt(value, key)
			if !valid || number < 0 {
				Raise("invalid_input", "usage requires non-negative integer token counts")
			}
			values[index] = number
		}
		input.Usage = &TokenUsage{Input: int64(values[0]), Output: int64(values[1]), CacheRead: int64(values[2]), CacheWrite: int64(values[3])}
	}
	if value, ok := body["nodeId"].(string); ok {
		input.NodeId = &value
	}
	if value, ok := body["moduleId"].(string); ok {
		input.ModuleId = &value
	}
	input.Limitations = graphAcceptanceLimitationsOfPayload(body)
	if value, ok := appBodyInt(body, "seq"); ok {
		input.Seq = &value
	}
	writeJSON(w, http.StatusOK, app.runtime.ControlGraph(r.PathValue("taskId"), input))
}

func (app *GraphApp) serveGraphAcceptanceWaive(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := GraphAcceptanceWaiveInput{
		AcceptanceId: appBodyString(body, "acceptanceId"),
		Reason:       appBodyString(body, "reason"),
		Evidence:     appBodyString(body, "evidence"),
		RequestId:    appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.WaiveAcceptance(r.PathValue("taskId"), input))
}

func (app *GraphApp) serveGraphModule(w http.ResponseWriter, r *http.Request) {
	query := ModuleHistoryQuery{}
	if value, ok := appQueryNumber(r, "after"); ok {
		query.After = value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.GraphModule(r.PathValue("taskId"), r.PathValue("moduleId"), query))
}

func (app *GraphApp) serveGraphModuleValues(w http.ResponseWriter, r *http.Request) {
	query := ModuleHistoryQuery{FullValues: true, IncludeTransitions: boolPointer(false)}
	writeJSON(w, http.StatusOK, app.runtime.GraphModule(r.PathValue("taskId"), r.PathValue("moduleId"), query))
}

func boolPointer(value bool) *bool { return &value }

func (app *GraphApp) serveGraphModuleTransition(w http.ResponseWriter, r *http.Request) {
	transitionID := r.PathValue("transitionId")
	query := ModuleHistoryQuery{TransitionID: &transitionID, Limit: 1}
	explanation := app.runtime.GraphModule(r.PathValue("taskId"), r.PathValue("moduleId"), query)
	writeJSON(w, http.StatusOK, appModuleTransition(explanation, transitionID))
}

func appModuleTransition(explanation ModuleExplanation, transitionID string) any {
	for _, transition := range explanation.Transitions {
		if transition.ID == transitionID {
			return transition
		}
	}
	return nil
}

func (app *GraphApp) serveGraphEdge(w http.ResponseWriter, r *http.Request) {
	query := EdgeHistoryQuery{}
	if value, ok := appQueryNumber(r, "before"); ok {
		query.Before = value
	}
	if value, ok := appQueryNumber(r, "limit"); ok {
		query.Limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.GraphEdge(r.PathValue("taskId"), r.PathValue("edgeId"), query))
}

func (app *GraphApp) serveGraphEdgeDelivery(w http.ResponseWriter, r *http.Request) {
	deliveryID := r.PathValue("deliveryId")
	query := EdgeHistoryQuery{DeliveryID: &deliveryID, FullValue: true, Limit: 1}
	explanation := app.runtime.GraphEdge(r.PathValue("taskId"), r.PathValue("edgeId"), query)
	writeJSON(w, http.StatusOK, appEdgeDelivery(explanation, deliveryID))
}

func appEdgeDelivery(explanation EdgeExplanation, deliveryID string) any {
	for _, delivery := range explanation.Deliveries {
		if delivery.ID == deliveryID {
			return delivery
		}
	}
	return nil
}
