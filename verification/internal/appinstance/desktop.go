package appinstance

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const defaultDesktop = "/Users/macmini/Library/Application Support/Graph/capabilities/agent-desktop/node_modules/agent-desktop/bin/agent-desktop-darwin-arm64"

type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type Window struct {
	PID        int    `json:"pid"`
	ID         string `json:"id"`
	App        string `json:"app_name"`
	Title      string `json:"title"`
	Visible    bool   `json:"visible"`
	Accessible bool   `json:"accessible"`
	Bounds     Rect   `json:"bounds"`
}

type Match struct {
	Ref   string `json:"ref_id"`
	Role  string `json:"role"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Node struct {
	Ref   string `json:"ref_id"`
	Role  string `json:"role"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Snapshot struct {
	RefCount int    `json:"ref_count"`
	Nodes    []Node `json:"nodes"`
}

type envelope struct {
	OK      bool            `json:"ok"`
	Command string          `json:"command"`
	Data    json.RawMessage `json:"data"`
	Error   *struct {
		Code        string `json:"code"`
		Message     string `json:"message"`
		Disposition struct {
			Retry string `json:"retry"`
		} `json:"disposition"`
	} `json:"error"`
}

type Desktop struct {
	Bin     string
	Timeout time.Duration
	App     string
}

func NewDesktop(app string) *Desktop {
	bin := strings.TrimSpace(os.Getenv("GRAPH_DESKTOP_BIN"))
	if bin == "" {
		bin = defaultDesktop
	}
	return &Desktop{Bin: bin, Timeout: 90 * time.Second, App: app}
}

func (d *Desktop) Available() error {
	info, err := os.Stat(d.Bin)
	if err != nil {
		return fmt.Errorf("agent-desktop binary missing at %s: %w", d.Bin, err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("agent-desktop binary is not executable: %s", d.Bin)
	}
	return nil
}

func (d *Desktop) Permission() (string, error) {
	raw, err := d.call("permissions")
	if err != nil {
		return "", err
	}
	var data struct {
		Accessibility struct {
			State string `json:"state"`
		} `json:"accessibility"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", err
	}
	return data.Accessibility.State, nil
}

func (d *Desktop) call(args ...string) (json.RawMessage, error) {
	attempts := 0
	var last error
	for attempts < 2 {
		attempts++
		out, err := d.exec(args)
		if err == nil {
			return out, nil
		}
		last = err
		var refused *Refusal
		if errorsAs(err, &refused) && refused.Retry == "safe" {
			time.Sleep(300 * time.Millisecond)
			continue
		}
		break
	}
	return nil, last
}

func (d *Desktop) exec(args []string) (json.RawMessage, error) {
	timeout := d.Timeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	cmd := exec.Command(d.Bin, args...)
	done := make(chan struct{})
	var out []byte
	var err error
	go func() {
		out, err = cmd.Output()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return nil, &Refusal{Code: "timeout", Message: "agent-desktop " + strings.Join(args, " ") + " exceeded " + timeout.String()}
	}
	var parsed envelope
	if parseErr := json.Unmarshal(out, &parsed); parseErr != nil {
		if err != nil {
			return nil, &Refusal{Code: "exec", Message: err.Error()}
		}
		return nil, &Refusal{Code: "invalid_output", Message: string(out[:min(len(out), 400)])}
	}
	if !parsed.OK {
		refusal := &Refusal{Code: "refused", Message: "agent-desktop refused " + parsed.Command}
		if parsed.Error != nil {
			refusal.Code = parsed.Error.Code
			refusal.Message = parsed.Error.Message
			refusal.Retry = parsed.Error.Disposition.Retry
		}
		return nil, refusal
	}
	return parsed.Data, nil
}

type Refusal struct {
	Code    string
	Message string
	Retry   string
}

func (r *Refusal) Error() string { return r.Code + ": " + r.Message }

func (d *Desktop) Windows() ([]Window, error) {
	raw, err := d.call("list-windows")
	if err != nil {
		return nil, err
	}
	var windows []Window
	if err := json.Unmarshal(raw, &windows); err != nil {
		return nil, err
	}
	return windows, nil
}

func (d *Desktop) WindowForPID(pid int) (Window, error) {
	windows, err := d.Windows()
	if err != nil {
		return Window{}, err
	}
	matches := []Window{}
	for _, window := range windows {
		if window.PID == pid {
			matches = append(matches, window)
		}
	}
	if len(matches) == 0 {
		return Window{}, &Refusal{Code: "no_window", Message: fmt.Sprintf("no window for pid %d", pid)}
	}
	for _, window := range matches {
		if window.Visible {
			return window, nil
		}
	}
	return matches[0], nil
}

func (d *Desktop) Find(windowID, role, name string, exact bool) (Match, error) {
	args := []string{"find", "--window-id", windowID}
	if role != "" {
		args = append(args, "--role", role)
	}
	if name != "" {
		args = append(args, "--name", name)
	}
	if exact {
		args = append(args, "--exact")
	}
	args = append(args, "--timeout-ms", "20000")
	raw, err := d.call(args...)
	if err != nil {
		return Match{}, err
	}
	var data struct {
		Matches []Match `json:"matches"`
		Total   int     `json:"total_matches"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return Match{}, err
	}
	if len(data.Matches) == 0 {
		return Match{}, &Refusal{Code: "no_target", Message: fmt.Sprintf("no element %q in window %s", name, windowID)}
	}
	return data.Matches[0], nil
}

func (d *Desktop) Click(window Window, name string) (Match, error) {
	match, err := d.Find(window.ID, "button", name, true)
	if err != nil {
		return Match{}, err
	}
	if _, err := d.call("click", match.Ref); err != nil {
		return Match{}, err
	}
	return match, nil
}

func (d *Desktop) Snapshot(windowID string) (Snapshot, error) {
	raw, err := d.call("snapshot", "--window-id", windowID, "--skeleton", "--timeout-ms", "20000")
	if err != nil {
		return Snapshot{}, err
	}
	var data struct {
		RefCount int             `json:"ref_count"`
		Tree     json.RawMessage `json:"tree"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return Snapshot{}, err
	}
	snapshot := Snapshot{RefCount: data.RefCount}
	nodes := []Node{}
	if len(data.Tree) > 0 {
		collectNodes(data.Tree, &nodes)
	}
	snapshot.Nodes = nodes
	return snapshot, nil
}

func collectNodes(raw json.RawMessage, out *[]Node) {
	var node struct {
		Ref      string            `json:"ref_id"`
		Role     string            `json:"role"`
		Name     string            `json:"name"`
		Value    any               `json:"value"`
		Children []json.RawMessage `json:"children"`
	}
	if err := json.Unmarshal(raw, &node); err != nil {
		return
	}
	if node.Name != "" {
		value := ""
		if text, ok := node.Value.(string); ok {
			value = text
		}
		*out = append(*out, Node{Ref: node.Ref, Role: node.Role, Name: node.Name, Value: value})
	}
	for _, child := range node.Children {
		collectNodes(child, out)
	}
}

func (s Snapshot) Names() []string {
	names := make([]string, 0, len(s.Nodes))
	for _, node := range s.Nodes {
		names = append(names, node.Name)
	}
	return names
}

func (s Snapshot) Contains(name string) bool {
	for _, node := range s.Nodes {
		if strings.Contains(node.Name, name) {
			return true
		}
	}
	return false
}

func (s Snapshot) Rendered() string {
	return strings.Join(s.Names(), " | ")
}

func (d *Desktop) ScreenshotRect(window Window, path string) error {
	region := fmt.Sprintf("%d,%d,%d,%d",
		int(window.Bounds.X), int(window.Bounds.Y), int(window.Bounds.Width), int(window.Bounds.Height))
	cmd := exec.Command("/usr/sbin/screencapture", "-x", "-R"+region, path)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("screencapture failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		return statErr
	}
	if info.Size() == 0 {
		return fmt.Errorf("screencapture produced an empty file at %s", path)
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func errorsAs(err error, target **Refusal) bool {
	refusal, ok := err.(*Refusal)
	if ok {
		*target = refusal
	}
	return ok
}

func atoi(value string) int {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	return number
}
