package appinstance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSurfaceDesktop records the arguments agent-desktop receives. The surface
// runner must scope a shell surface to the run's own window id: every Graph copy
// reports the same app name, so an --app lookup can open the user's tray.
const fakeSurfaceDesktop = `#!/bin/sh
state="$FAKE_SURFACE_STATE"
printf '%s\n' "$*" >> "$state/args"
case "$1" in
  list-windows)
    printf '%s\n' '{"version":"2.6","ok":true,"command":"list-windows","data":[{"pid":4242,"id":"w-1","app_name":"Graph","title":"Graph","visible":true,"accessible":true,"bounds":{"x":0,"y":0,"width":1440,"height":900}}]}'
    ;;
  snapshot)
    printf '%s\n' '{"version":"2.6","ok":true,"command":"snapshot","data":{"ref_count":3,"tree":{"role":"menu","children":[{"role":"menuitem","ref_id":"@s:e1","children":[{"role":"menu","name":"Graph","children":[{"role":"menuitem","name":"打开 Graph","ref_id":"@s:e2"},{"role":"menuitem","name":"退出 Graph","ref_id":"@s:e3"}]}]}]},"window":{"id":"w-1","title":"Graph"}}}'
    ;;
  *)
    printf '%s\n' '{"version":"2.6","ok":false,"command":"'$1'","error":{"code":"INVALID_ARGS","message":"unsupported","disposition":{"retry":"unsafe"}}}'
    ;;
esac
`

func fakeSurfaceDesktopBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "agent-desktop")
	if err := os.WriteFile(path, []byte(fakeSurfaceDesktop), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_SURFACE_STATE", state)
	return path
}

func surfaceDesktop(t *testing.T) *Desktop {
	t.Helper()
	desktop := NewDesktop("Graph")
	desktop.Bin = fakeSurfaceDesktopBinary(t)
	return desktop
}

func TestSurfaceSnapshotScopesToTheRunWindowNotTheAppName(t *testing.T) {
	desktop := surfaceDesktop(t)
	result, err := desktop.SnapshotSurfaceWindow(Window{ID: "w-1", App: "Graph"}, "menu-bar-extras")
	if err != nil {
		t.Fatalf("surface snapshot: %v", err)
	}
	if !result.Contains("打开 Graph") || !result.Contains("退出 Graph") {
		t.Fatalf("the surface must expose both menu items, got %v", result.Names())
	}
	args, err := os.ReadFile(filepath.Join(os.Getenv("FAKE_SURFACE_STATE"), "args"))
	if err != nil {
		t.Fatal(err)
	}
	line := string(args)
	if !strings.Contains(line, "--window-id w-1") {
		t.Fatalf("the surface snapshot must be scoped by window id, got %q", line)
	}
	if strings.Contains(line, "--app") {
		t.Fatalf("a window-scoped snapshot must not fall back to the ambiguous app name: %q", line)
	}
}

func TestSurfaceSnapshotByAppNameIsOnlyAnExplicitFallback(t *testing.T) {
	desktop := surfaceDesktop(t)
	if _, err := desktop.SnapshotSurface("Graph", "menu-bar-extras"); err != nil {
		t.Fatalf("surface snapshot: %v", err)
	}
	args, err := os.ReadFile(filepath.Join(os.Getenv("FAKE_SURFACE_STATE"), "args"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "--app Graph") {
		t.Fatalf("the documented fallback must pass --app, got %q", string(args))
	}
}

func TestSurfaceSnapshotRefusesAnEmptyWindowID(t *testing.T) {
	desktop := surfaceDesktop(t)
	if _, err := desktop.SnapshotSurfaceWindow(Window{}, "menu-bar-extras"); err == nil {
		t.Fatal("a surface snapshot without a window id must be refused, not guessed by app name")
	}
}
