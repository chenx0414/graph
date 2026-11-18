package graph

import (
	"path/filepath"
	"strings"

	"os"
)

const MODULE_TIMEOUT_MS = 5000

const MODULE_MAX_BYTES = 1048576

var MISSING_INPUT = map[string]any{"__missing__": true}

type ModuleEvaluationInput struct {
	Entry   string
	Inputs  map[string]any
	State   any
	Trigger string
	Limits  *ModuleLimits
}

type ModuleMeasurement struct {
	Ms           int64 `json:"ms"`
	PeakRssBytes any   `json:"peakRssBytes"`
}

type ModuleEvaluationResult struct {
	OK          bool              `json:"ok"`
	State       any               `json:"state"`
	Outputs     map[string]any    `json:"outputs"`
	Diagnostics []string          `json:"diagnostics"`
	Error       string            `json:"error,omitempty"`
	Measurement ModuleMeasurement `json:"measurement"`
}

func EvaluateModule(input ModuleEvaluationInput, memoryCapMb *int) ModuleEvaluationResult {
	limits := resolvedModuleLimits(input.Limits)
	payload := stringifyJSON(moduleEvalPayload{ID: "eval-1", Inputs: input.Inputs, State: input.State, Trigger: input.Trigger})
	fail := func(message string, ms int64) ModuleEvaluationResult {
		return ModuleEvaluationResult{OK: false, State: input.State, Outputs: map[string]any{}, Diagnostics: []string{}, Error: message, Measurement: ModuleMeasurement{Ms: ms, PeakRssBytes: nil}}
	}
	if len(payload) > limits.inputBytes {
		return fail("module input exceeds "+itoa(limits.inputBytes)+" bytes", 0)
	}
	if len(stringifyJSON(input.State)) > limits.stateBytes {
		return fail("module state exceeds "+itoa(limits.stateBytes)+" bytes", 0)
	}
	scratch, err := os.MkdirTemp("", "graph-module-")
	if err != nil {
		return fail(err.Error(), 0)
	}
	defer os.RemoveAll(scratch)
	started := NowMillis()
	worker := moduleWorkerPath()
	workerBody, err := os.ReadFile(worker)
	if err != nil {
		return fail(err.Error(), NowMillis()-started)
	}
	entryBody, err := os.ReadFile(input.Entry)
	if err != nil {
		return fail(err.Error(), NowMillis()-started)
	}
	if err := os.WriteFile(filepath.Join(scratch, "worker.mjs"), workerBody, 0o444); err != nil {
		return fail(err.Error(), NowMillis()-started)
	}
	if err := os.WriteFile(filepath.Join(scratch, "module.mjs"), entryBody, 0o444); err != nil {
		return fail(err.Error(), NowMillis()-started)
	}
	memory := limits.memoryMb
	if memoryCapMb != nil {
		memory = *memoryCapMb
	}
	run := RunModuleContainer(ModuleContainerInput{
		Directory: scratch, Payload: payload + "\n", MemoryMb: memory, TimeoutMs: limits.timeoutMs, MaxOutputBytes: limits.outputBytes,
	})
	ms := NowMillis() - started
	code, codeMissing := moduleRunCode(run)
	if codeMissing || code != 0 {
		stderr := strings.TrimSpace(moduleRunText(run, "stderr", "Stderr"))
		if stderr == "" {
			shown := "null"
			if !codeMissing {
				shown = itoa(code)
			}
			stderr = "module process exited with " + shown
		}
		return fail(stderr, ms)
	}
	stdout := strings.TrimSpace(moduleRunText(run, "stdout", "Stdout"))
	lines := strings.Split(stdout, "\n")
	line := ""
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			line = strings.TrimSpace(lines[i])
			break
		}
	}
	if line == "" {
		return fail("module produced no result", ms)
	}
	parsedValue, parsedOK := tryParseJSON(line)
	parsed, ok := parsedValue.(map[string]any)
	if !parsedOK || !ok {
		return fail("module produced invalid JSON", ms)
	}
	if truth, _ := parsed["ok"].(bool); !truth {
		message := "module threw"
		if s, ok := parsed["error"].(string); ok && s != "" {
			message = s
		}
		return fail(message, ms)
	}
	result := asMap(parsed["result"])
	if result == nil {
		result = map[string]any{}
	}
	outputs, outputsOK := result["outputs"].(map[string]any)
	diagnostics, diagOK := stringSlice(result["diagnostics"])
	if !outputsOK || !diagOK {
		return fail("module must return {state,outputs:object,diagnostics:string[]}", ms)
	}
	if len(stringifyJSON(result)) > limits.outputBytes {
		return fail("module reply exceeds "+itoa(limits.outputBytes)+" bytes", ms)
	}
	state := result["state"]
	if _, present := result["state"]; !present {
		state = nil
	}
	if len(stringifyJSON(state)) > limits.stateBytes {
		return fail("module state exceeds "+itoa(limits.stateBytes)+" bytes", ms)
	}
	return ModuleEvaluationResult{
		OK: true, State: state, Outputs: outputs, Diagnostics: diagnostics,
		Measurement: ModuleMeasurement{Ms: ms, PeakRssBytes: nil},
	}
}

type resolvedLimits struct {
	timeoutMs   int
	memoryMb    int
	inputBytes  int
	outputBytes int
	stateBytes  int
}

func resolvedModuleLimits(in *ModuleLimits) resolvedLimits {
	out := resolvedLimits{timeoutMs: MODULE_TIMEOUT_MS, memoryMb: MODULE_MEMORY_MB, inputBytes: MODULE_MAX_BYTES, outputBytes: MODULE_MAX_BYTES, stateBytes: MODULE_MAX_BYTES}
	if in == nil {
		return out
	}
	if in.TimeoutMs != nil {
		out.timeoutMs = *in.TimeoutMs
	}
	if in.MemoryMb != nil {
		out.memoryMb = *in.MemoryMb
	}
	if in.InputBytes != nil {
		out.inputBytes = *in.InputBytes
	}
	if in.OutputBytes != nil {
		out.outputBytes = *in.OutputBytes
	}
	if in.StateBytes != nil {
		out.stateBytes = *in.StateBytes
	}
	return out
}

func moduleWorkerPath() string {
	return runtimeScript("module-worker.mjs")
}

type moduleEvalPayload struct {
	ID      string         `json:"id"`
	Inputs  map[string]any `json:"inputs"`
	State   any            `json:"state"`
	Trigger string         `json:"trigger"`
}

func moduleRunCode(run any) (int, bool) {
	m := asMap(run)
	if m == nil {
		return 1, false
	}
	v, ok := m["code"]
	if !ok {
		v, ok = m["Code"]
	}
	if !ok || v == nil {
		return 0, true
	}
	return int(sqlInt(v)), false
}

func moduleRunText(run any, keys ...string) string {
	m := asMap(run)
	return mapString(m, keys...)
}

func stringSlice(v any) ([]string, bool) {
	items, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, len(items))
	for i, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, false
		}
		out[i] = s
	}
	return out, true
}

func WriteModuleEntry(dir, name, source string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name+".mjs")
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		return "", err
	}
	return path, nil
}
