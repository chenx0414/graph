package embedded

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	absolute, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

func TestTheEmbeddedPresetsMatchTheRepositoryCopies(t *testing.T) {
	compareTree(t, Presets(), filepath.Join(repoRoot(t), "presets"))
}

// The runtime host scripts live in exactly one place: this package's embedded copy, which the
// binary ships. There used to be a byte-identical second copy under src/runtime that this test
// compared against; with one copy there is nothing to drift, and the paths that used to read the
// disk first now resolve the embedded file. What has to hold instead is that src/runtime is gone,
// so nobody re-creates a second copy and the resolution order stays single-source.
func TestTheRuntimeHostScriptsHaveNoSecondCopyOutsideTheBinary(t *testing.T) {
	stale := filepath.Join(repoRoot(t), "src", "runtime")
	if _, err := os.Stat(stale); err == nil {
		t.Fatalf("%s exists again: the runtime host scripts must live only in embedded/runtime", stale)
	}
	for _, name := range []string{"check-resolver.cjs", "module-worker.mjs"} {
		if _, err := fs.ReadFile(Runtime(), name); err != nil {
			t.Fatalf("the binary must still ship %s: %v", name, err)
		}
	}
}

func embeddedFileList(t *testing.T, source fs.FS) map[string]bool {
	t.Helper()
	files := map[string]bool{}
	err := fs.WalkDir(source, ".", func(relative string, entry fs.DirEntry, incoming error) error {
		if incoming != nil || entry.IsDir() {
			return incoming
		}
		files[relative] = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func compareTree(t *testing.T, source fs.FS, disk string) {
	t.Helper()
	embedded := embeddedFileList(t, source)
	var differences []string
	for relative := range embedded {
		body, err := fs.ReadFile(source, relative)
		if err != nil {
			t.Fatal(err)
		}
		onDisk, err := os.ReadFile(filepath.Join(disk, relative))
		switch {
		case err != nil:
			differences = append(differences, "只在 embedded 里，仓库根缺失: "+relative)
		case string(onDisk) != string(body):
			differences = append(differences, "内容不一致: "+relative)
		}
	}
	_ = filepath.WalkDir(disk, func(path string, entry fs.DirEntry, incoming error) error {
		if incoming != nil || entry.IsDir() || excludedAsset(entry.Name()) {
			return incoming
		}
		relative, err := filepath.Rel(disk, path)
		if err != nil {
			return err
		}
		if !embedded[relative] {
			differences = append(differences, "只在仓库根里，embedded 缺失: "+relative)
		}
		return nil
	})
	if len(differences) > 0 {
		sort.Strings(differences)
		t.Fatalf("内嵌副本与仓库根不一致，请同步 %s：\n  %s", disk, strings.Join(differences, "\n  "))
	}
}

func excludedAsset(name string) bool {
	return name == ".DS_Store" || name == "README.md"
}
