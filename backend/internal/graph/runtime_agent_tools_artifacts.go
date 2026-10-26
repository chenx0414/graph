package graph

import (
	"strings"

	"errors"
)

// agentToolsArtifactsHandlers are the handlers of the Artifacts tools.
func agentToolsArtifactsHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"artifact_list": func(id string, params map[string]any) any {
			trust := agentToolsTrimmedString(params["trust"])
			if trust != "" && !agentToolsContains(agentToolsArtifactTrusts, trust) {
				panic(errors.New("Unsupported artifact trust"))
			}
			query := ArtifactQuery{}
			if value := agentToolsTrimmedString(params["namespace"]); value != "" {
				query.Namespace = value
			}
			if value := agentToolsTrimmedString(params["prefix"]); value != "" {
				query.Prefix = value
			}
			if value := agentToolsTrimmedString(params["schema"]); value != "" {
				query.Schema = value
			}
			if value := agentToolsTrimmedString(params["tag"]); value != "" {
				query.Tag = value
			}
			if trust != "" {
				query.Trust = trust
			}
			if value, ok := params["includeRetired"].(bool); ok {
				query.IncludeRetired = value
			}
			if value, ok := params["latestOnly"].(bool); ok {
				query.LatestOnly = &value
			}
			if value, ok := agentToolsNumber(params["limit"]); ok {
				limit := int(value)
				query.Limit = &limit
			}
			if value := agentToolsTrimmedString(params["cursor"]); value != "" {
				query.Cursor = value
			}
			return agentToolsText(stringifyJSON(artifacts.list(query)))
		},
		"artifact_read": func(id string, params map[string]any) any {
			artifactID := strings.TrimSpace(agentToolsString(params["artifactId"]))
			if artifactID == "" || len(artifactID) > 200 {
				panic(errors.New("A bounded artifactId is required"))
			}
			var version *int
			if _, present := params["version"]; present {
				value, ok := agentToolsNumberValue(params["version"])
				if !ok || value != float64(int(value)) || value < 1 {
					panic(errors.New("version must be a positive integer when provided"))
				}
				requested := int(value)
				version = &requested
			}
			resolved := version
			if resolved == nil {
				record := artifacts.get(artifactID, nil)
				resolved = &record.Version
			}
			maxBytes := 0
			if value, ok := agentToolsNumber(params["maxBytes"]); ok {
				maxBytes = int(value)
			}
			return agentToolsText(stringifyJSON(artifacts.read(artifactID, *resolved, maxBytes)))
		},
		"artifact_publish": func(id string, params map[string]any) any {
			if _, present := params["graphId"]; present && input.Role != "master" {
				Raise("permission", "Only main can select an artifact graph")
			}
			if raw, present := params["graphId"]; present {
				text, isString := raw.(string)
				if !isString || strings.TrimSpace(text) == "" {
					Raise("invalid_input", "graphId must be a nonempty string")
				}
			}
			namespace := strings.TrimSpace(agentToolsString(params["namespace"]))
			if !agentToolsContains(artifacts.access.AllowedNamespaces, namespace) {
				panic(errors.New("Namespace " + namespace + " is not writable by this Agent"))
			}
			var metadata map[string]any
			if raw, present := params["metadata"]; present {
				record := asMap(raw)
				if record == nil {
					Raise("invalid_input", "Artifact metadata must be an object")
				}
				metadata = record
			}
			var tags []string
			if raw, ok := params["tags"].([]any); ok {
				for _, item := range raw {
					tags = append(tags, agentToolsString(item))
				}
			}
			var expectedVersion *int64
			if value, ok := agentToolsNumber(params["expectedVersion"]); ok {
				number := int64(value)
				expectedVersion = &number
			}
			publish := PublishArtifactInput{
				Namespace: namespace, Name: agentToolsString(params["name"]),
				RequestId: agentToolsString(params["requestId"]), Tags: tags,
				ExpectedVersion: expectedVersion, Metadata: metadata,
			}
			// TODO(port): the TypeScript publish input carries an optional graphId, so an
			// artifact can be published into a graph the Agent owns. PublishArtifactInput
			// has no such field yet, so the graph is validated but not forwarded.
			if text, ok := params["sourcePath"].(string); ok && strings.TrimSpace(text) != "" {
				publish.SourcePath = text
			}
			if text, ok := params["content"].(string); ok {
				publish.Content = &text
			}
			if text, ok := params["mediaType"].(string); ok && strings.TrimSpace(text) != "" {
				publish.MediaType = strings.TrimSpace(text)
			}
			if text, ok := params["schema"].(string); ok && strings.TrimSpace(text) != "" {
				publish.Schema = strings.TrimSpace(text)
			}
			if text, ok := params["title"].(string); ok && strings.TrimSpace(text) != "" {
				publish.Title = strings.TrimSpace(text)
			}
			if text, ok := params["summary"].(string); ok && strings.TrimSpace(text) != "" {
				publish.Summary = strings.TrimSpace(text)
			}
			return agentToolsText(stringifyJSON(artifacts.publish(publish)))
		},
		"artifact_retire": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["version"])
			return agentToolsText(stringifyJSON(artifacts.retire(
				agentToolsString(params["artifactId"]), int(version),
				agentToolsString(params["reason"]), agentToolsString(params["requestId"]))))
		},
		"artifact_promote": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["version"])
			return agentToolsText(stringifyJSON(artifacts.promote(ArtifactPromoteInput{
				ArtifactId: agentToolsString(params["artifactId"]), Version: int(version),
				RequestId: agentToolsString(params["requestId"]),
			})))
		},
	}
}
