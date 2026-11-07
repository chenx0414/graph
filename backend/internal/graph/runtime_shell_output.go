package graph

import (
	"fmt"
	"os"
	"path/filepath"
)

func renderShellOutput(stateDir string, value any, compact bool) any {
	details := asMap(asMap(value)["details"])
	output, present := details["shellOutput"].(string)
	if !present || len(output) <= TOOL_RESULT_LIMIT {
		return nil
	}
	directory := filepath.Join(stateDir, "tool-results", "shell")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		panic(err)
	}
	handle := filepath.Join(directory, toolResultsDigest(output)+".txt")
	if err := os.WriteFile(handle, []byte(output), 0o600); err != nil {
		panic(err)
	}
	code := "signal"
	if value := details["exitCode"]; value != nil {
		code = fmt.Sprint(value)
	}
	footer := fmt.Sprintf("\n[Process exited with code %s. Full output: %s]", code, handle)
	limit := SHELL_OUTPUT_LIMIT
	if compact {
		limit = SUMMARY_LIMIT
	}
	summary := SummarizeToolResult(output, handle, limit-len(footer)) + footer
	answer := agentToolsText(summary)
	answer["details"] = map[string]any{"exitCode": details["exitCode"], "fullOutputPath": handle}
	return answer
}
