package graph

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"bytes"
)

func layoutNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		number, _ := typed.Float64()
		return number
	default:
		return 0
	}
}

func layoutNumberDefault(value any, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return layoutNumber(value)
}

func layoutElk(graph map[string]any) map[string]any {
	payload, err := json.Marshal(graph)
	if err != nil {
		panic(err)
	}
	elkPath := filepath.Join(ApplicationRoot, "node_modules", "elkjs", "lib", "elk.bundled.js")
	if _, err := os.Stat(elkPath); err != nil {
		return layoutFallback(graph)
	}
	script := `import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const ELK = require(process.env.GRAPH_ELK);
const elk = new ELK();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  const out = await elk.layout(JSON.parse(raw));
  process.stdout.write(JSON.stringify(out));
});`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Env = append(os.Environ(), "GRAPH_ELK="+elkPath)
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.Output()
	if err != nil {
		panic(fmt.Errorf("elkjs layout failed: %w", err))
	}
	var laid map[string]any
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.UseNumber()
	if err := decoder.Decode(&laid); err != nil {
		panic(err)
	}
	return laid
}
