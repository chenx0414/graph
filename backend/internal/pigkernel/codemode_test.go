package pigkernel

import (
	"strings"
	"testing"
)

// Code mode is the kernel's own: the tool, its description, the prompt section
// that lists the callable tools and the sandbox all come from PiG. Re-writing
// any of it in the daemon is how the daemon grew a second, weaker code mode,
// so what this test proves is that the extension is the kernel's object - its
// upstream description and its own section - and not a local imitation.
func TestCodemodeExtensionIsTheKernelsOwn(t *testing.T) {
	extension, err := CodemodeExtension(CodemodeOptions{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatalf("build the kernel's code mode: %v", err)
	}
	if extension.Name != "codemode" {
		t.Fatalf("extension name %q, want codemode", extension.Name)
	}
	if len(extension.Tools) == 0 || extension.Tools[0].ToolSchema.Name != "codemode" {
		t.Fatalf("the extension has to register the codemode tool, got %d tools", len(extension.Tools))
	}
	description := extension.Tools[0].ToolSchema.Description
	for _, want := range []string{"await tools.", "survives a restart"} {
		if !strings.Contains(description, want) {
			t.Fatalf("the description has to be the kernel's own, missing %q in %q", want, description)
		}
	}
	sections := []string{}
	for _, section := range extension.Sections {
		sections = append(sections, section.Key)
	}
	if len(sections) != 1 || sections[0] != "codemode" {
		t.Fatalf("the extension has to bring its own prompt section, got %v", sections)
	}
}
