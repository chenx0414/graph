package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

const (
	toolSearchBM25K1 = 1.5
	toolSearchBM25B  = 0.75
)

type toolDisclosureOptions struct {
	Enabled           bool
	TopKDefault       int
	TopKMax           int
	MaxSchema         int
	OnDemand          []string
	FloatEnabled      bool
	FloatK            int
	FloatMinExposures int
	Pinned            []string
	Usage             *toolUsage
}

var toolDisclosureOnDemandDefaults = []string{
	"get_agent_combination", "get_resource", "list_agent_combinations", "search_resources", "inspect_graph_system",
	"agent_browser", "agent_browser_web_search",
}

var toolDisclosureOnDemandPrefixes = []string{"mcp__", "mcp_"}

func defaultToolDisclosureOptions() toolDisclosureOptions {
	options := toolDisclosureOptions{
		Enabled:           os.Getenv("GRAPH_TOOL_SEARCH") != "0",
		TopKDefault:       5,
		TopKMax:           20,
		MaxSchema:         4000,
		OnDemand:          append([]string{}, toolDisclosureOnDemandDefaults...),
		FloatEnabled:      os.Getenv("GRAPH_TOOL_SEARCH_FLOAT") != "0",
		FloatK:            15,
		FloatMinExposures: 30,
		Pinned:            append([]string{}, toolFloatPinnedDefaults...),
	}
	if value, error := strconv.Atoi(strings.TrimSpace(os.Getenv("GRAPH_TOOL_SEARCH_FLOAT_K"))); error == nil && value > 0 {
		options.FloatK = value
	}
	if value, error := strconv.Atoi(strings.TrimSpace(os.Getenv("GRAPH_TOOL_SEARCH_FLOAT_MIN_EXPOSURES"))); error == nil && value >= 0 {
		options.FloatMinExposures = value
	}
	if value := strings.TrimSpace(os.Getenv("GRAPH_TOOL_SEARCH_PIN")); value != "" {
		for _, name := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				options.Pinned = append(options.Pinned, trimmed)
			}
		}
	}
	if value, error := strconv.Atoi(strings.TrimSpace(os.Getenv("GRAPH_TOOL_SEARCH_TOP_K"))); error == nil && value > 0 {
		options.TopKDefault = value
	}
	if value := strings.TrimSpace(os.Getenv("GRAPH_TOOL_SEARCH_ON_DEMAND")); value != "" {
		names := []string{}
		for _, name := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				names = append(names, trimmed)
			}
		}
		if len(names) > 0 {
			options.OnDemand = names
		}
	}
	return options
}

func toolSearchTokens(text string) []string {
	tokens := []string{}
	word := strings.Builder{}
	han := []rune{}
	flushWord := func() {
		if word.Len() > 0 {
			tokens = append(tokens, word.String())
			word.Reset()
		}
	}
	flushHan := func() {
		switch {
		case len(han) > 1:
			for index := 0; index+1 < len(han); index++ {
				tokens = append(tokens, string(han[index:index+2]))
			}
		case len(han) == 1:
			tokens = append(tokens, string(han))
		}
		han = han[:0]
	}
	for _, character := range strings.ToLower(text) {
		switch {
		case unicode.Is(unicode.Han, character):
			flushWord()
			han = append(han, character)
		case unicode.IsLetter(character) || unicode.IsDigit(character) || character == '_':
			flushHan()
			word.WriteRune(character)
		default:
			flushWord()
			flushHan()
		}
	}
	flushWord()
	flushHan()
	return tokens
}

type toolDisclosureEntry struct {
	spec        pigkernel.ToolSpec
	text        string
	schema      any
	frequencies map[string]int
	length      int
}

type toolDisclosureIndex struct {
	entries   []*toolDisclosureEntry
	documents map[string]int
	average   float64
}

func newToolDisclosureIndex(tools []pigkernel.ToolSpec, maxSchema int) *toolDisclosureIndex {
	index := &toolDisclosureIndex{documents: map[string]int{}}
	total := 0
	for _, spec := range tools {
		schema, _ := json.Marshal(spec.Parameters)
		text := strings.TrimSpace(spec.Name + " " + spec.Description + " " + string(schema))
		if maxSchema > 0 && len(text) > maxSchema {
			text = text[:maxSchema]
		}
		frequencies := map[string]int{}
		count := 0
		for _, token := range toolSearchTokens(text) {
			frequencies[token]++
			count++
		}
		for token := range frequencies {
			index.documents[token]++
		}
		total += count
		index.entries = append(index.entries, &toolDisclosureEntry{
			spec: spec, text: text, schema: spec.Parameters, frequencies: frequencies, length: count,
		})
	}
	if len(index.entries) > 0 {
		index.average = float64(total) / float64(len(index.entries))
	}
	return index
}

func (index *toolDisclosureIndex) search(query, expression string, topK int) []map[string]any {
	hits := []map[string]any{}
	if index == nil || len(index.entries) == 0 {
		return hits
	}
	var pattern *regexp.Regexp
	if strings.TrimSpace(expression) != "" {
		compiled, error := regexp.Compile("(?i)" + expression)
		if error != nil {
			return hits
		}
		pattern = compiled
	}
	terms := toolSearchTokens(query)
	type scored struct {
		entry *toolDisclosureEntry
		score float64
	}
	ranked := []scored{}
	for _, entry := range index.entries {
		if pattern != nil && !pattern.MatchString(entry.text) {
			continue
		}
		score := 0.0
		for _, term := range terms {
			frequency := entry.frequencies[term]
			if frequency == 0 {
				continue
			}
			documents := index.documents[term]
			idf := math.Log(1 + (float64(len(index.entries))-float64(documents)+0.5)/(float64(documents)+0.5))
			normalized := 1 - toolSearchBM25B + toolSearchBM25B*float64(entry.length)/index.average
			score += idf * (float64(frequency) * (toolSearchBM25K1 + 1)) / (float64(frequency) + toolSearchBM25K1*normalized)
		}
		if len(terms) > 0 && score <= 0 {
			continue
		}
		ranked = append(ranked, scored{entry: entry, score: score})
	}
	sort.SliceStable(ranked, func(left, right int) bool {
		if ranked[left].score != ranked[right].score {
			return ranked[left].score > ranked[right].score
		}
		return ranked[left].entry.spec.Name < ranked[right].entry.spec.Name
	})
	if topK > 0 && len(ranked) > topK {
		ranked = ranked[:topK]
	}
	for _, item := range ranked {
		hits = append(hits, map[string]any{
			"name":         item.entry.spec.Name,
			"description":  item.entry.spec.Description,
			"input_schema": item.entry.schema,
			"score":        math.Round(item.score*1000) / 1000,
		})
	}
	return hits
}

func toolDisclosureOnDemand(name string, options toolDisclosureOptions) bool {
	for _, candidate := range options.OnDemand {
		if candidate == name {
			return true
		}
	}
	for _, prefix := range toolDisclosureOnDemandPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func toolDisclosurePlanOf(tools []pigkernel.ToolSpec, options toolDisclosureOptions) (map[string]pigkernel.ToolSpec, *toolDisclosureIndex) {
	if !options.Enabled {
		return nil, nil
	}
	deferred := map[string]pigkernel.ToolSpec{}
	inline := []string{}
	byName := map[string]pigkernel.ToolSpec{}
	for _, spec := range tools {
		byName[spec.Name] = spec
		if toolDisclosureOnDemand(spec.Name, options) {
			deferred[spec.Name] = spec
			continue
		}
		inline = append(inline, spec.Name)
	}
	for name := range toolFloatSinkable(inline, options.Usage, options) {
		deferred[name] = byName[name]
	}
	if len(deferred) == 0 {
		return nil, nil
	}
	list := make([]pigkernel.ToolSpec, 0, len(deferred))
	for _, spec := range deferred {
		list = append(list, spec)
	}
	sort.SliceStable(list, func(left, right int) bool { return list[left].Name < list[right].Name })
	return deferred, newToolDisclosureIndex(list, options.MaxSchema)
}

func toolSearchSpec(deferred map[string]pigkernel.ToolSpec, index *toolDisclosureIndex, options toolDisclosureOptions) pigkernel.ToolSpec {
	names := make([]string, 0, len(deferred))
	for name := range deferred {
		names = append(names, name)
	}
	sort.Strings(names)
	return pigkernel.ToolSpec{
		Name:        "tool_search",
		Description: fmt.Sprintf("Discover the %d bound tools that are not listed in your tools: search by keyword (Chinese supported) or `regex`; each hit carries its full parameter schema. Run one with `tool_invoke`.", len(names)),
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Keyword search over tool name, description and parameters."},
				"regex": map[string]any{"type": "string", "description": "Case-insensitive regular expression over the same text."},
				"top_k": map[string]any{"type": "number", "description": fmt.Sprintf("Maximum hits (default %d, max %d).", options.TopKDefault, options.TopKMax)},
			},
		},
		Execute: func(_ context.Context, args map[string]any) (string, error) {
			query, _ := args["query"].(string)
			expression, _ := args["regex"].(string)
			if strings.TrimSpace(query) == "" && strings.TrimSpace(expression) == "" {
				return "", fmt.Errorf("Provide at least one of query or regex")
			}
			topK := options.TopKDefault
			if value, ok := args["top_k"].(float64); ok && value > 0 {
				topK = int(value)
			}
			if topK > options.TopKMax {
				topK = options.TopKMax
			}
			payload, error := json.Marshal(map[string]any{"hits": index.markSearched(query, expression, topK, options.Usage), "total": len(deferred)})
			if error != nil {
				return "", error
			}
			return string(payload), nil
		},
	}
}

func toolInvokeSpec(deferred map[string]pigkernel.ToolSpec, options toolDisclosureOptions) pigkernel.ToolSpec {
	return pigkernel.ToolSpec{
		Name:        "tool_invoke",
		Description: "Run one tool that `tool_search` returned, without loading its schema: pass the exact `name` and its `arguments` object.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":      map[string]any{"type": "string", "description": "Exact tool name from a tool_search hit."},
				"arguments": map[string]any{"type": "object", "description": "Arguments object for that tool."},
			},
			"required": []any{"name"},
		},
		Execute: func(ctx context.Context, args map[string]any) (string, error) {
			name, _ := args["name"].(string)
			spec, ok := deferred[name]
			if !ok {
				return "", fmt.Errorf("Unknown on-demand tool %q: run tool_search first", name)
			}
			options.Usage.mark(toolUsageCall, name)
			_ = options.Usage.flush()
			parameters, _ := args["arguments"].(map[string]any)
			if parameters == nil {
				parameters = map[string]any{}
			}
			if spec.Result != nil {
				value, error := spec.Result(ctx, parameters)
				if error != nil {
					return "", error
				}
				payload, marshalError := json.Marshal(value)
				if marshalError != nil {
					return fmt.Sprint(value), nil
				}
				return string(payload), nil
			}
			if spec.Execute != nil {
				return spec.Execute(ctx, parameters)
			}
			return "", fmt.Errorf("Tool %q cannot run on demand", name)
		},
	}
}

func pigToolSearchSurface(tools []pigkernel.ToolSpec, provider pigkernel.ProviderBridge, options toolDisclosureOptions) ([]pigkernel.ToolSpec, pigkernel.ProviderBridge, error) {
	deferred, index := toolDisclosurePlanOf(tools, options)
	if deferred == nil {
		return tools, provider, nil
	}
	guarded := make([]pigkernel.ToolSpec, 0, len(tools)+2)
	for _, spec := range tools {
		if _, hidden := deferred[spec.Name]; !hidden {
			guarded = append(guarded, toolUsageWrapped(spec, options.Usage))
			continue
		}
		name := spec.Name
		spec.Result = func(context.Context, map[string]any) (any, error) {
			return nil, fmt.Errorf("%s is an on-demand tool: call tool_search to read its schema, then tool_invoke with name=%q", name, name)
		}
		spec.Execute = nil
		guarded = append(guarded, spec)
	}
	guarded = append(guarded, toolSearchSpec(deferred, index, options), toolInvokeSpec(deferred, options))
	stream := provider.Stream
	provider.Stream = func(ctx context.Context, transcript []map[string]any, streamOptions map[string]any) (pigkernel.EventStream, error) {
		filtered := make([]map[string]any, 0, len(transcript))
		for _, message := range transcript {
			added, present := message["toolsAdded"].([]any)
			if !present {
				filtered = append(filtered, message)
				continue
			}
			visible := make([]any, 0, len(added))
			for _, tool := range added {
				if _, hidden := deferred[controlledToolName(tool)]; hidden {
					continue
				}
				visible = append(visible, tool)
			}
			copy := map[string]any{}
			for key, value := range message {
				copy[key] = value
			}
			copy["toolsAdded"] = visible
			filtered = append(filtered, copy)
		}
		if options.Usage != nil {
			exposed := []string{}
			for _, message := range filtered {
				added, present := message["toolsAdded"].([]any)
				if !present {
					continue
				}
				exposed = exposed[:0]
				for _, tool := range added {
					exposed = append(exposed, controlledToolName(tool))
				}
			}
			for _, name := range exposed {
				options.Usage.mark(toolUsageExposure, name)
			}
			_ = options.Usage.flush()
		}
		return stream(ctx, filtered, streamOptions)
	}
	return guarded, provider, nil
}
