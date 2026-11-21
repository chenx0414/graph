package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHeadlessJourneyUsesAnOverlayWithoutChangingProductSources(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app")
	state := filepath.Join(root, "verification", ".run", "boundary", "state")
	out := filepath.Join(root, "verification", "evidence", "boundary")
	if err := os.MkdirAll(app, 0o700); err != nil {
		t.Fatal(err)
	}
	product := filepath.Join(app, "product.go")
	edited := "package main\n\nvar inProgress = true\n"
	if err := os.WriteFile(product, []byte(edited), 0o600); err != nil {
		t.Fatal(err)
	}

	result := runJourneyHeadless(paths{AppDir: app}, runMeta{StateDir: state}, journey{ID: "boundary"}, out)
	if result.OK || result.ExitCode == 0 {
		t.Fatalf("the fixture without a Go module must return the runner's error: %+v", result)
	}
	files, err := os.ReadDir(app)
	if err != nil || len(files) != 1 || files[0].Name() != "product.go" {
		t.Fatalf("the runner wrote into the product directory: %v, %v", files, err)
	}
	content, err := os.ReadFile(product)
	if err != nil || string(content) != edited {
		t.Fatalf("the existing edit changed: %q, %v", content, err)
	}
	overlayDir := filepath.Join(filepath.Dir(state), "overlay", "boundary")
	raw, err := os.ReadFile(filepath.Join(overlayDir, "overlay.json"))
	if err != nil {
		t.Fatal(err)
	}
	var overlay struct {
		Replace map[string]string
	}
	if err := json.Unmarshal(raw, &overlay); err != nil {
		t.Fatal(err)
	}
	virtual := filepath.Join(app, "zz_verifygraph_driver_test.go")
	if driver := overlay.Replace[virtual]; driver != filepath.Join(overlayDir, "driver_test.go") {
		t.Fatalf("the injected test must live under the run: %+v", overlay)
	}
}
