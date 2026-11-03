package graph

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// serveTasks is the task list.
func (app *GraphApp) serveTasks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.User().List())
}

// serveProjectEntries is the entry list of one project.
func (app *GraphApp) serveProjectEntries(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("projectId")
	query := r.URL.Query().Get("q")
	limit := 80
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": app.runtime.ProjectEntries(projectID, query, limit)})
}

// serveConversations is the conversation list.
func (app *GraphApp) serveConversations(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, app.runtime.Conversations().List(appQueryBool(r, "archived")))
}

// serveConversationCreate starts one conversation.
func (app *GraphApp) serveConversationCreate(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := TaskRuntimeConversationInput{RequestId: appBodyString(body, "requestId")}
	if value, ok := body["projectId"].(string); ok && value != "" {
		input.ProjectId = &value
	}
	if value, ok := body["title"].(string); ok && value != "" {
		input.Title = &value
	}
	if value, ok := body["text"].(string); ok && value != "" {
		input.Text = &value
	}
	if value, ok := body["model"].(string); ok && value != "" {
		input.Model = &value
	}
	if value, ok := body["thinkingLevel"].(string); ok && value != "" {
		input.ThinkingLevel = &value
	}
	if raw, ok := body["attachments"].([]any); ok {
		attachments, err := appAttachments(raw)
		if err != nil {
			panic(err)
		}
		input.Attachments = attachments
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Create(input))
}

// appAttachments reads the attachment list of a request body.
func appAttachments(raw []any) ([]AttachmentInput, error) {
	attachments := []AttachmentInput{}
	for _, item := range raw {
		record, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("attachment must be an object")
		}
		attachment := AttachmentInput{}
		if value, ok := record["name"].(string); ok {
			attachment.Name = value
		}
		if value, ok := record["type"].(string); ok {
			attachment.Type = value
		}
		if value, ok := record["size"].(float64); ok {
			attachment.Size = int64(value)
		}
		if value, ok := record["text"].(string); ok {
			attachment.Text = value
		}
		if value, ok := record["data"].(string); ok {
			attachment.Data = &value
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

// serveConversation is one conversation with its messages.
func (app *GraphApp) serveConversation(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, app.appConversationView(conversationID, r))
}

// appConversationView reads one conversation.
func (app *GraphApp) appConversationView(conversationID string, r *http.Request) any {
	provider, ok := any(app.runtime.Conversations()).(interface {
		View(conversationID string, query NodeEntryQuery) map[string]any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the conversation view yet")
	}
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
	return provider.View(conversationID, query)
}

// serveAttachment serves one inline image attachment.
func (app *GraphApp) serveAttachment(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("messageId")
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		Raise("not_found", "Attachment not found")
	}
	attachment := app.runtime.Conversations().Attachment(messageID, index)
	kind, _ := attachment["type"].(string)
	raw := appAttachmentBytes(attachment["bytes"])
	w.Header().Set("cache-control", "private, max-age=3600")
	w.Header().Set("x-content-type-options", "nosniff")
	w.Header().Set("Content-Type", kind)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// appAttachmentBytes reads the bytes of one inline attachment. The runtime
// hands the base64 payload over; the wire format is the raw image.
func appAttachmentBytes(value any) []byte {
	switch typed := value.(type) {
	case []byte:
		return typed
	case *string:
		if typed == nil {
			return nil
		}
		decoded, err := base64.StdEncoding.DecodeString(*typed)
		if err != nil {
			return []byte(*typed)
		}
		return decoded
	case string:
		decoded, err := base64.StdEncoding.DecodeString(typed)
		if err != nil {
			return []byte(typed)
		}
		return decoded
	}
	return nil
}

// serveConversationHistory is the message history of one conversation.
func (app *GraphApp) serveConversationHistory(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
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
	writeJSON(w, http.StatusOK, app.runtime.Conversations().History(conversationID, query))
}

// serveConversationArtifacts is the artifact list of one conversation.
func (app *GraphApp) serveConversationArtifacts(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, app.runtime.ListConversationArtifacts(conversationID, appArtifactQuery(r)))
}

// appArtifactQuery reads the artifact query parameters.
func appArtifactQuery(r *http.Request) ArtifactQuery {
	query := ArtifactQuery{}
	values := r.URL.Query()
	query.ArtifactId = values.Get("artifactId")
	query.Namespace = values.Get("namespace")
	query.Prefix = values.Get("prefix")
	query.Schema = values.Get("schema")
	query.Tag = values.Get("tag")
	query.Trust = values.Get("trust")
	query.IncludeRetired = values.Get("includeRetired") == "true"
	if values.Get("latestOnly") == "false" {
		latest := false
		query.LatestOnly = &latest
	}
	if value, ok := appQueryInt(r, "limit"); ok {
		query.Limit = &value
	}
	query.Cursor = values.Get("cursor")
	return query
}

// serveDraftGraph is the graph draft of one conversation.
func (app *GraphApp) serveDraftGraph(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	view := app.appConversationView(conversationID, r)
	record, _ := view.(map[string]any)
	// The proposal holds its spec as the native proposal itself, not as a
	// plain record: reading it as a record found nothing, and the draft was
	// always drawn empty. A named version is the one the console opened.
	proposal := record["proposal"]
	if value, ok := appQueryInt(r, "version"); ok {
		if value < 1 {
			Raise("invalid_input", "version must be a positive integer")
		}
		proposal = app.runtime.Conversations().Proposal(conversationID, value)
	}
	var definition any
	switch spec := proposal.(type) {
	case NativeProposal:
		definition = spec.Definition
	case map[string]any:
		switch inner := spec["spec"].(type) {
		case NativeProposal:
			definition = inner.Definition
		case map[string]any:
			value, ok := inner["definition"]
			if !ok {
				Raise("invalid_proposal", "A native graph definition is required")
			}
			definition = value
		}
	}
	if definition == nil {
		writeJSON(w, http.StatusOK, appGraphStructure{Containers: []appGraphContainer{}, Nodes: []appGraphNode{}, Loops: []any{}, Layout: appEmptyLayout()})
		return
	}
	parsed := ParseGraphDefinition(definition)
	structure := app.appNativeGraphStructure(parsed, nil)
	interfaces := []any{}
	for _, edgeID := range appSortedKeys(parsed.Edges) {
		edge := parsed.Edges[edgeID]
		parts := strings.SplitN(edge.To, ".", 2)
		id := parts[0]
		port := ""
		if len(parts) > 1 {
			port = parts[1]
		}
		protocol := (*string)(nil)
		if target, found := parsed.Nodes[id]; found {
			if reference, ok := target.Inputs[port]; ok {
				value := reference.Protocol
				protocol = &value
			}
		} else if target, found := parsed.Modules[id]; found {
			if reference, ok := target.Inputs[port]; ok {
				value := reference.Protocol
				protocol = &value
			}
		}
		interfaces = append(interfaces, map[string]any{
			"edgeId": edgeID, "from": edge.From, "to": edge.To,
			"protocol": protocol, "latest": nil, "deliveries": []any{},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": structure.Nodes, "containers": structure.Containers, "loops": structure.Loops,
		"layout": structure.Layout, "interfaces": interfaces,
	})
}

// serveProposal is one proposal version of a conversation.
func (app *GraphApp) serveProposal(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil || version < 1 {
		Raise("invalid_input", "version must be a positive integer")
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Proposal(conversationID, version))
}

// serveConversationMessage adds one user message.
func (app *GraphApp) serveConversationMessage(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	input := TaskRuntimeChatInput{
		Text:      appBodyString(body, "text"),
		RequestId: appBodyString(body, "requestId"),
	}
	if raw, ok := body["attachments"].([]any); ok {
		attachments, err := appAttachments(raw)
		if err != nil {
			panic(err)
		}
		input.Attachments = attachments
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Chat(conversationID, input))
}

// serveConversationMessageCancel drops one queued message.
func (app *GraphApp) serveConversationMessageCancel(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	input := TaskRuntimeCancelInput{
		MessageId: r.PathValue("messageId"),
		RequestId: appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().CancelMessage(conversationID, input))
}

// serveConversationModel selects the model of one conversation.
func (app *GraphApp) serveConversationModel(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().SelectModel(
		conversationID, appBodyString(body, "model"), appBodyString(body, "thinkingLevel"), appBodyString(body, "requestId")))
}

// serveConversationCompact compacts the history of one conversation.
func (app *GraphApp) serveConversationCompact(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Compact(conversationID, appBodyString(body, "requestId")))
}

// serveConversationArchive archives one conversation.
func (app *GraphApp) serveConversationArchive(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Archive(conversationID, appBodyString(body, "requestId")))
}

// serveConversationUnarchive restores one archived conversation.
func (app *GraphApp) serveConversationUnarchive(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Unarchive(conversationID, appBodyString(body, "requestId")))
}

// serveConversationBind binds one conversation to a project.
func (app *GraphApp) serveConversationBind(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Bind(
		conversationID, appBodyString(body, "projectId"), appBodyString(body, "requestId")))
}

// serveConversationConfirm confirms the proposal of one conversation.
func (app *GraphApp) serveConversationConfirm(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	draftRevision, _ := appBodyInt(body, "draftRevision")
	input := TaskRuntimeConfirmInput{
		ProposalVersion: proposalVersion,
		DraftRevision:   draftRevision,
		TargetBranch:    appBodyString(body, "targetBranch"),
		RequestId:       appBodyString(body, "requestId"),
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Confirm(conversationID, input))
}

// serveConversationDraftArchive archives one draft version.
func (app *GraphApp) serveConversationDraftArchive(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().ArchiveDraft(conversationID, TaskRuntimeDraftInput{
		ProposalVersion: proposalVersion, RequestId: appBodyString(body, "requestId"),
	}))
}

// serveConversationDraftRestore restores one archived draft version.
func (app *GraphApp) serveConversationDraftRestore(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().RestoreDraft(conversationID, TaskRuntimeDraftInput{
		ProposalVersion: proposalVersion, RequestId: appBodyString(body, "requestId"),
	}))
}

// serveConversationDraftDelete deletes one draft version.
func (app *GraphApp) serveConversationDraftDelete(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	proposalVersion, _ := appBodyInt(body, "proposalVersion")
	writeJSON(w, http.StatusOK, app.runtime.Conversations().DeleteDraft(conversationID, TaskRuntimeDraftInput{
		ProposalVersion: proposalVersion, RequestId: appBodyString(body, "requestId"),
	}))
}

// serveConversationPause pauses one conversation.
func (app *GraphApp) serveConversationPause(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Pause(conversationID, appBodyString(body, "requestId")))
}

// serveConversationResume resumes one conversation.
func (app *GraphApp) serveConversationResume(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Resume(conversationID, appBodyString(body, "requestId")))
}

// serveConversationSteer steers one running conversation.
func (app *GraphApp) serveConversationSteer(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	provider, ok := any(app.runtime.Conversations()).(interface {
		Steer(conversationID string, requestID string) map[string]any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the conversation steer yet")
	}
	writeJSON(w, http.StatusOK, provider.Steer(conversationID, appBodyString(body, "requestId")))
}

// serveConversationInterrupt interrupts one running conversation.
func (app *GraphApp) serveConversationInterrupt(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	body := appJSONBody(w, r)
	provider, ok := any(app.runtime.Conversations()).(interface {
		Interrupt(conversationID string, requestID string) map[string]any
	})
	if !ok {
		Raise("internal", "The task runtime does not expose the conversation interrupt yet")
	}
	writeJSON(w, http.StatusOK, provider.Interrupt(conversationID, appBodyString(body, "requestId")))
}

// serveConversationEvents is the event page of one conversation.
func (app *GraphApp) serveConversationEvents(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	after := 0
	if value, ok := appQueryInt(r, "after"); ok {
		after = value
	}
	limit := 200
	if value, ok := appQueryInt(r, "limit"); ok {
		limit = value
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Events(conversationID, after, limit))
}

// serveConversationStream is the event stream of one conversation.
func (app *GraphApp) serveConversationStream(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	after := appEventCursor(r)
	app.appWriteEventStream(w, r, app.runtime.Conversations().Watch(conversationID, after))
}

// serveConversationGoal reads the persistent goal of one conversation.
func (app *GraphApp) serveConversationGoal(w http.ResponseWriter, r *http.Request) {
	conversationID := r.PathValue("conversationId")
	writeJSON(w, http.StatusOK, map[string]any{"conversationId": conversationID, "goal": app.runtime.store.Goal(conversationID)})
}

// serveConversationGoalAction applies one /goal action.
func (app *GraphApp) serveConversationGoalAction(w http.ResponseWriter, r *http.Request) {
	body := appJSONBody(w, r)
	input := GoalInput{
		Action: appBodyString(body, "action"), Objective: appBodyString(body, "objective"),
		CheckNote: appBodyString(body, "checkNote"), RequestID: appBodyString(body, "requestId"),
	}
	if value, ok := body["budgetTokens"].(float64); ok && value >= 0 {
		input.BudgetTokens = int64(value)
	}
	writeJSON(w, http.StatusOK, app.runtime.Conversations().Goal(r.PathValue("conversationId"), input))
}
