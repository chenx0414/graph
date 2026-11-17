package mygoauto

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func shortSocketPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join("/tmp", fmt.Sprintf("mygoauto-%d.sock", time.Now().UnixNano()))
	t.Cleanup(func() { os.Remove(path) })
	return path
}

func fakeServer(t *testing.T, answer func(method string, params map[string]any) any) string {
	t.Helper()
	path := shortSocketPath(t)
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				reader := bufio.NewReader(conn)
				for {
					line, err := reader.ReadBytes('\n')
					if err != nil {
						return
					}
					var request struct {
						ID     int            `json:"id"`
						Method string         `json:"method"`
						Params map[string]any `json:"params"`
					}
					if json.Unmarshal(line, &request) != nil {
						return
					}
					payload, _ := json.Marshal(map[string]any{"id": request.ID, "result": answer(request.Method, request.Params)})
					conn.Write(append(payload, '\n'))
				}
			}(conn)
		}
	}()
	return path
}

func TestTheClientSpeaksTheAutomationProtocol(t *testing.T) {
	calls := []string{}
	path := fakeServer(t, func(method string, params map[string]any) any {
		calls = append(calls, method)
		switch method {
		case "windows":
			return map[string]any{"windows": []map[string]any{{
				"id": 1, "title": "Graph", "kind": "content", "focused": true, "visible": true,
				"bounds": map[string]any{"x": 10, "y": 20, "width": 800, "height": 600},
			}}}
		case "tree":
			return map[string]any{"window": 1, "nodes": []map[string]any{
				{"id": "1", "role": "button", "label": "轨迹"},
				{"id": "2", "role": "button", "label": "洞察"},
			}}
		case "act", "idle":
			return map[string]any{}
		default:
			return map[string]any{}
		}
	})

	conn, err := dial(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.close()

	windows, err := conn.windows(time.Second)
	if err != nil || len(windows) != 1 || windows[0].Bounds.Width != 800 {
		t.Fatalf("windows %+v err %v", windows, err)
	}
	nodes, err := conn.tree(1, time.Second)
	if err != nil || len(nodes) != 2 {
		t.Fatalf("tree %+v err %v", nodes, err)
	}
	if err := conn.act(1, "2", "press", "", time.Second); err != nil {
		t.Fatal(err)
	}
	if err := conn.idle(1, time.Second); err != nil {
		t.Fatal(err)
	}
	want := []string{"windows", "tree", "act", "idle"}
	if strings.Join(calls, ",") != strings.Join(want, ",") {
		t.Fatalf("calls %v, want %v", calls, want)
	}
}

func TestTheClientReportsProtocolErrorsAsSuch(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		bufio.NewReader(conn).ReadBytes('\n')
		conn.Write([]byte("{\"id\":1,\"error\":{\"code\":\"stale\",\"message\":\"stale ref @e4\"}}\n"))
	}()

	conn, err := dial(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.close()
	_, err = conn.tree(1, time.Second)
	if err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("want a stale error, got %v", err)
	}
	if _, err := dial(filepath.Join(t.TempDir(), "missing.sock"), 100*time.Millisecond); err == nil {
		t.Fatal("dialing a missing socket must fail")
	}
}

func TestResolveMatchesRoleLabelUnderAndNth(t *testing.T) {
	tree := Tree{
		{ID: "1", Role: "group", Label: "会话"},
		{ID: "2", Role: "button", Label: "复制", Parent: "1"},
		{ID: "3", Role: "button", Label: "复制", Parent: "1"},
		{ID: "4", Role: "group", Label: "编队"},
		{ID: "5", Role: "button", Label: "复制", Parent: "4"},
		{ID: "6", Role: "textField", Label: "", Placeholder: "消息"},
	}
	if node, err := tree.Find(Sel{Role: "button", Label: "复制", Under: "编队"}); err != nil || node.ID != "5" {
		t.Fatalf("under 编队: %+v %v", node, err)
	}
	if node, err := tree.Find(Sel{Role: "button", Label: "复制", Under: "会话", Nth: 1}); err != nil || node.ID != "3" {
		t.Fatalf("nth 1 under 会话: %+v %v", node, err)
	}
	if _, err := tree.Find(Sel{Role: "button", Label: "洞察"}); err == nil {
		t.Fatal("a missing label must fail with a hint, not an empty node")
	} else if !strings.Contains(err.Error(), "tree has 0 match") {
		t.Fatalf("error should say how many matched: %v", err)
	}
	if matches := tree.Contain("复"); len(matches) != 3 {
		t.Fatalf("contain matches %d", len(matches))
	}
	clone := Tree{{ID: "1", Role: "button", Label: "轨迹"}, {ID: "9", Role: "group", Label: "洞察概览"}}
	added, removed := Diff(tree, clone)
	if len(added) != 1 || len(removed) != 5 {
		t.Fatalf("diff added %d removed %d", len(added), len(removed))
	}
}

func TestTheOverlayOnlyAddsOneFileToTheApp(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	run := t.TempDir()
	replacements, err := overlayFiles(repo, run)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(repo, "app", "zz_automation_e2e.go")
	if _, ok := replacements[target]; !ok {
		t.Fatalf("overlay mapping %v", replacements)
	}
	payload, err := os.ReadFile(replacements[target])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), "//go:build e2e") || !strings.Contains(string(payload), "plugins/automation") {
		t.Fatalf("injected file: %s", payload)
	}
	if err := os.WriteFile(target, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := overlayFiles(repo, run); err == nil {
		t.Fatal("an overlay that would replace an existing app file must be refused")
	}
}

func TestGlobalReportNamesWhatChanged(t *testing.T) {
	opts := Options{RunDir: t.TempDir(), RepoRoot: t.TempDir(), UserHome: t.TempDir()}.withDefaults()
	if err := prepare(opts); err != nil {
		t.Fatal(err)
	}
	session := &Session{opts: opts, baseline: opts.Baseline()}
	if err := session.VerifyGlobal(); err != nil {
		t.Fatalf("an untouched run must pass: %v", err)
	}
	if err := os.WriteFile(opts.stubLog(), []byte("bootout gui/501/dev.graph.daemon\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := session.VerifyGlobal()
	if err == nil || !strings.Contains(err.Error(), "launchctl") {
		t.Fatalf("a launchctl call through the shadow must fail the run, got %v", err)
	}
	if report := session.GlobalReport(); report.Unchanged {
		t.Fatal("the report must not claim an unchanged run")
	}
}

func TestPrepareLocksTheLaunchAgentsDirectory(t *testing.T) {
	opts := Options{RunDir: t.TempDir(), RepoRoot: t.TempDir(), ShortID: "t1"}
	opts = opts.withDefaults()
	if err := prepare(opts); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(opts.launchAgentsDir())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o200 != 0 {
		t.Fatalf("LaunchAgents mode %v must be read-only so installLaunchAgent fails", info.Mode().Perm())
	}
	if err := os.WriteFile(filepath.Join(opts.launchAgentsDir(), "dev.graph.daemon.plist"), []byte("x"), 0o644); err == nil {
		t.Fatal("writing a launch agent must fail inside the run directory")
	}
	stub, err := os.ReadFile(filepath.Join(opts.stubDir(), "launchctl"))
	if err != nil || !strings.Contains(string(stub), "exit 1") {
		t.Fatalf("launchctl shadow %s %v", stub, err)
	}
	if !strings.Contains(strings.Join(opts.env(true), "\n"), "HOME="+opts.homeDir()) {
		t.Fatal("the sandboxed HOME must reach the child processes")
	}
	if strings.Contains(strings.Join(opts.env(true), "\n"), "GRAPH_STATE_DIR="+filepath.Join(opts.UserHome, "Library")) {
		t.Fatal("the child must never point at the user's state directory")
	}
}
