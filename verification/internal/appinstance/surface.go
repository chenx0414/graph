package appinstance

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SurfaceSnapshot is a shell surface (menu bar extras, dock, notification
// center) plus the window that surface presents, so the caller can capture the
// exact region a user would look at.
type SurfaceSnapshot struct {
	Snapshot
	Surface string
	App     string
	Window  Window
}

// AppNameForPID answers the application name agent-desktop uses for a process.
// A binary run directly reports its executable name (graph-verify-ui), while a
// bundled build reports Graph; asking instead of assuming keeps both working.
func (d *Desktop) AppNameForPID(pid int) (string, error) {
	windows, err := d.Windows()
	if err != nil {
		return "", err
	}
	for _, window := range windows {
		if window.PID == pid && window.App != "" {
			return window.App, nil
		}
	}
	if d.App != "" {
		return d.App, nil
	}
	return "", fmt.Errorf("agent-desktop reports no window for pid %d", pid)
}

// SnapshotSurface reads a shell surface scoped to one app name. Unlike
// open-system-surface it does not open anything: it observes the surface the
// app already publishes, so a tray journey can never click "退出 Graph" by
// accident. Use SnapshotSurfaceWindow when several instances share one app
// name; agent-desktop cannot disambiguate --app in that case.
func (d *Desktop) SnapshotSurface(app, surface string) (SurfaceSnapshot, error) {
	if strings.TrimSpace(app) == "" {
		return SurfaceSnapshot{}, fmt.Errorf("an app name is required to read surface %q", surface)
	}
	return d.snapshotSurface(surface, app, []string{"--app", app})
}

// SnapshotSurfaceWindow scopes the surface to the process that owns window.
// It is the safe form: the user's own Graph has the same app name as a
// verification instance, so --app can select the wrong process and a tray
// journey would open the user's menu instead of the isolated one.
func (d *Desktop) SnapshotSurfaceWindow(window Window, surface string) (SurfaceSnapshot, error) {
	if strings.TrimSpace(window.ID) == "" {
		return SurfaceSnapshot{}, fmt.Errorf("a window id is required to read surface %q safely", surface)
	}
	app := strings.TrimSpace(window.App)
	if app == "" {
		app = strings.TrimSpace(d.App)
	}
	if app == "" {
		app = "unknown"
	}
	result, err := d.snapshotSurface(surface, app, []string{"--window-id", window.ID})
	if err == nil && result.Window.ID == "" {
		result.Window = window
	}
	return result, err
}

func (d *Desktop) snapshotSurface(surface, app string, scope []string) (SurfaceSnapshot, error) {
	args := append([]string{"snapshot", "--surface", surface}, scope...)
	args = append(args, "--include-bounds", "--timeout-ms", "20000")
	raw, err := d.call(args...)
	if err != nil {
		return SurfaceSnapshot{}, err
	}
	var data struct {
		RefCount int             `json:"ref_count"`
		Tree     json.RawMessage `json:"tree"`
		Window   struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"window"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return SurfaceSnapshot{}, err
	}
	snapshot := Snapshot{RefCount: data.RefCount}
	nodes := []Node{}
	if len(data.Tree) > 0 {
		collectSurfaceNodes(data.Tree, &nodes)
	}
	snapshot.Nodes = nodes
	result := SurfaceSnapshot{Snapshot: snapshot, Surface: surface, App: app}
	if data.Window.ID != "" {
		windows, listErr := d.Windows()
		if listErr != nil {
			return result, listErr
		}
		for _, window := range windows {
			if window.ID == data.Window.ID {
				result.Window = window
				break
			}
		}
		if result.Window.ID == "" {
			return result, fmt.Errorf("surface %s reported window %s, which list-windows does not know", surface, data.Window.ID)
		}
	}
	return result, nil
}

// Notifications reads Notification Center entries for one app. It is
// evidence, not a pass condition: a verification run has no reason to post a
// system notification unless a real task finished.
func (d *Desktop) Notifications(app string) (json.RawMessage, error) {
	return d.call("list-notifications", "--app", app)
}

// collectSurfaceNodes keeps unnamed nodes that carry a ref. A shell surface's
// root is an unnamed menuitem: the one element a journey must press to open the
// menu. collectNodes drops it because it only maps readable text, which left the
// menu-bar-extras lane unable to open the tray it had just found.
func collectSurfaceNodes(raw json.RawMessage, out *[]Node) {
	var node struct {
		Ref      string            `json:"ref_id"`
		Role     string            `json:"role"`
		Name     string            `json:"name"`
		Value    any               `json:"value"`
		Bounds   Rect              `json:"bounds"`
		Children []json.RawMessage `json:"children"`
	}
	if err := json.Unmarshal(raw, &node); err != nil {
		return
	}
	if node.Name != "" || node.Ref != "" {
		value := ""
		if text, ok := node.Value.(string); ok {
			value = text
		}
		*out = append(*out, Node{Ref: node.Ref, Role: node.Role, Name: node.Name, Value: value, Bounds: node.Bounds})
	}
	for _, child := range node.Children {
		collectSurfaceNodes(child, out)
	}
}

// SurfaceLabel is the evidence-facing name of a surface snapshot.
func (s SurfaceSnapshot) SurfaceLabel() string {
	if s.Window.ID != "" {
		return fmt.Sprintf("%s (%s %s)", s.Surface, s.Window.ID, s.Window.Title)
	}
	return s.Surface
}

// ContentRect is the union of the surface's non-empty element bounds: the menu
// bar icon plus the open menu. agent-desktop reports the menu bar extra's
// popup with real bounds only after the menu is opened, so this is computed
// from the snapshot that proved the items exist.
func (s SurfaceSnapshot) ContentRect() Rect {
	var union Rect
	set := false
	for _, node := range s.Nodes {
		b := node.Bounds
		if b.Width <= 0 || b.Height <= 0 {
			continue
		}
		if !set {
			union = b
			set = true
			continue
		}
		right := maxf(union.X+union.Width, b.X+b.Width)
		bottom := maxf(union.Y+union.Height, b.Y+b.Height)
		union.X = minf(union.X, b.X)
		union.Y = minf(union.Y, b.Y)
		union.Width = right - union.X
		union.Height = bottom - union.Y
	}
	return union
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// FocusWindow makes one window the frontmost window of its app. Surface
// snapshots are filtered by app name, and every verification copy is named
// Graph, so focusing our own window is what makes --app select the instance
// under test rather than the user's Graph or another run.
func (d *Desktop) FocusWindow(windowID string) error {
	if strings.TrimSpace(windowID) == "" {
		return fmt.Errorf("a window id is required")
	}
	_, err := d.call("focus-window", "--window-id", windowID)
	return err
}

// ScreenshotBounds captures one rectangle of the screen. The menu bar extra
// popup is not a window list-windows reports, so the rectangle comes from the
// surface snapshot's element bounds.
func (d *Desktop) ScreenshotBounds(rect Rect, path string) error {
	return d.ScreenshotRect(Window{Bounds: rect}, path)
}

// ClickRef presses one accessibility ref returned by a surface snapshot. It
// exists so a surface journey can open the menu bar extra by ref without ever
// naming a destructive menu item.
func (d *Desktop) ClickRef(ref string) (Match, error) {
	if strings.TrimSpace(ref) == "" {
		return Match{}, fmt.Errorf("an element ref is required")
	}
	if _, err := d.call("click", ref); err != nil {
		return Match{}, err
	}
	return Match{Ref: ref}, nil
}
