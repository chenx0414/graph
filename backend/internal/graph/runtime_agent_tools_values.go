package graph

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// agentToolsText is a text tool result.
func agentToolsText(value string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": value}},
		"details": map[string]any{},
	}
}

// agentToolsImage is an image tool result.
func agentToolsImage(data []byte, mimeType string) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{
			"type": "image", "data": base64.StdEncoding.EncodeToString(data), "mimeType": mimeType,
		}},
		"details": map[string]any{},
	}
}

// agentToolsParams is the argument object of one tool call.
func agentToolsParams(raw any) map[string]any {
	params, _ := raw.(map[string]any)
	if params == nil {
		return map[string]any{}
	}
	return params
}

// agentToolsImageMimeType is the image type of one path, if it is an image.
func agentToolsImageMimeType(path string) string {
	return agentToolsImageMimeTypes[strings.ToLower(filepath.Ext(path))]
}

// agentToolsMount is the granted root one absolute path belongs to.
func agentToolsMount(candidates []string, requested string) string {
	for _, candidate := range candidates {
		if requested == candidate || strings.HasPrefix(requested, candidate+string(os.PathSeparator)) {
			return candidate
		}
	}
	return ""
}

// agentToolsCommandOutput is the text of one command result.
func agentToolsCommandOutput(result CommandResult) string {
	code := "signal"
	if result.Code != nil {
		code = itoa(*result.Code)
	}
	return "exit " + code + "\n" + result.Stdout + result.Stderr
}

// agentToolsGitText runs one read-only git command and returns its output.
func agentToolsGitText(input AgentToolsInput, args []string, path string) string {
	full := append([]string{}, args...)
	if path != "" {
		full = append(full, "--", path)
	}
	result := input.Run("git", full, nil)
	return agentToolsCommandOutput(result)
}

// agentToolsNativeProposal is the native proposal of one tool call.
func agentToolsNativeProposal(value any) NativeProposal {
	record := asMap(value)
	if record == nil {
		Raise("invalid_proposal", "Expected a native proposal object with definition; use schemaVersion:2 graph JSON")
	}
	if _, exists := record["definition"]; !exists {
		Raise("invalid_proposal", "Expected a native proposal object with definition; use schemaVersion:2 graph JSON")
	}
	raw, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	var proposal NativeProposal
	if err := json.Unmarshal(raw, &proposal); err != nil {
		panic(err)
	}
	return proposal
}

// agentToolsResourceReference is the id and version of one resource reference.
func agentToolsResourceReference(rawID, explicitVersion any) (string, string) {
	id := strings.TrimSpace(agentToolsStringOrEmpty(rawID))
	version := ""
	if text, ok := explicitVersion.(string); ok && strings.TrimSpace(text) != "" {
		version = strings.TrimSpace(text)
	}
	separator := strings.LastIndex(id, "@")
	if separator > 0 && separator < len(id)-1 {
		embedded := strings.TrimSpace(id[separator+1:])
		if version != "" && version != embedded {
			panic(errors.New("Conflicting versions for capability " + id[:separator]))
		}
		version = embedded
		id = id[:separator]
	}
	return id, version
}

// agentToolsCapabilityView is the resource view the resource tools return.
func agentToolsCapabilityView(record map[string]any) map[string]any {
	if record == nil {
		record = map[string]any{}
	}
	id := mapString(record, "id", "Id")
	name := mapString(record, "name", "Name")
	if name == "" {
		name = id
	}
	description := mapString(record, "description", "Description")
	view := map[string]any{
		"id": id, "kind": mapString(record, "kind", "Kind"), "version": mapString(record, "version", "Version"),
		"name": name, "description": description, "source": mapString(record, "source", "Source"),
		"status": mapString(record, "status", "Status"), "grantsNoPermission": true,
	}
	if role := mapString(record, "role", "Role"); role != "" {
		view["role"] = role
	}
	if failure := mapString(record, "error", "Error"); failure != "" {
		view["error"] = failure
	}
	return view
}

// agentToolsGraphSectionQuery is the frozen definition read of one tool call.
func agentToolsGraphSectionQuery(params map[string]any) GraphSectionQuery {
	query := GraphSectionQuery{Section: agentToolsString(params["section"])}
	if raw, ok := params["id"].(string); ok {
		value := raw
		query.Id = &value
	}
	if value, ok := agentToolsNumber(params["after"]); ok {
		after := int(value)
		query.After = &after
	}
	if value, ok := agentToolsNumber(params["limit"]); ok {
		limit := int(value)
		query.Limit = &limit
	}
	return query
}

// agentToolsHarnessVariants reads the variant list of a harness probe.
func agentToolsHarnessVariants(value any) ([]HarnessProbeVariant, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, errors.New("variants must be a list of probe variants")
	}
	out := []HarnessProbeVariant{}
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("every probe variant must be an object with a label")
		}
		variant := HarnessProbeVariant{
			Label:   agentToolsStringOrEmpty(record["label"]),
			Axis:    agentToolsStringOrEmpty(record["axis"]),
			Recipe:  agentToolsStringOrEmpty(record["recipe"]),
			Model:   agentToolsStringOrEmpty(record["model"]),
			Harness: map[string]string{},
		}
		if raw, present := record["harness"]; present && raw != nil {
			harness, ok := raw.(map[string]any)
			if !ok {
				return nil, errors.New("a probe variant harness must be an object of prompt key to text")
			}
			for key, text := range harness {
				content, ok := text.(string)
				if !ok {
					return nil, errors.New("a probe variant harness value must be a string")
				}
				variant.Harness[key] = content
			}
		}
		out = append(out, variant)
	}
	return out, nil
}
