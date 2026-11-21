package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The example graphs are the only worked examples of the definition format, so they are also
// the thing a reader copies. Nothing parsed them, which is how four of them kept a `node
// --version` check long after the repository stopped containing JavaScript it could run.
func TestEveryExampleGraphIsAValidDefinition(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}
	paths, err := filepath.Glob(filepath.Join(root, "examples", "graphs", "*.json"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no example graph was found, so this test proves nothing")
	}
	for _, path := range paths {
		name := filepath.Base(path)
		t.Run(name, func(t *testing.T) {
			payload, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatalf("read: %v", readErr)
			}
			decoded, decodeErr := decodeExampleJSON(payload)
			if decodeErr != nil {
				t.Fatalf("%s is not valid JSON: %v", name, decodeErr)
			}
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("%s is not a valid definition: %v", name, recovered)
				}
			}()
			ParseGraphDefinition(decoded)
		})
	}
}

// A definition a reader copies must not teach a command this repository cannot show them.
func decodeExampleJSON(payload []byte) (any, error) {
	var decoded any
	err := json.Unmarshal(payload, &decoded)
	return decoded, err
}
