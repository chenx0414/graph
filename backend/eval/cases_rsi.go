// graph:table-writes-exempt: a case seeds the rows its RSI fixture runs against
package eval

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/graph"

	_ "modernc.org/sqlite"
)

type rsiRepo struct {
	Root     string
	StateDir string
}

func newRsiRepo(t *T, files map[string]string) rsiRepo {
	root, err := os.MkdirTemp("", "graph-eval-rsi-")
	if err != nil {
		t.Fatal("rsi-temp-dir", err)
	}
	repo := rsiRepo{Root: filepath.Join(root, "checkout"), StateDir: filepath.Join(root, "state")}
	if resolved, resolveErr := filepath.EvalSymlinks(root); resolveErr == nil {
		repo.Root = filepath.Join(resolved, "checkout")
		repo.StateDir = filepath.Join(resolved, "state")
	}
	if err := os.MkdirAll(repo.Root, 0o755); err != nil {
		t.Fatal("rsi-root", err)
	}
	if err := os.MkdirAll(repo.StateDir, 0o700); err != nil {
		t.Fatal("rsi-state", err)
	}
	for name, content := range files {
		path := filepath.Join(repo.Root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal("rsi-file-dir", err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal("rsi-file", err)
		}
	}
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "eval@example.invalid"},
		{"config", "user.name", "Graph Eval"},
		{"add", "-A"},
		{"commit", "-q", "-m", "fixture"},
	} {
		if output, runErr := gitIn(repo.Root, args...); runErr != nil {
			t.Fatal("rsi-git-"+strings.Join(args, "-"), fmt.Errorf("%v: %s", runErr, output))
		}
	}
	return repo
}

func newRsiStore(t *T, stateDir string) (*graph.TaskStore, func()) {
	path := filepath.Join(stateDir, "tasks.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal("rsi-store-open", err)
	}
	store := graph.NewTaskStore(db, path)
	if _, err := store.DB.Exec("INSERT INTO projects(id,root,grants) VALUES('eval-project',?,'[]')", stateDir); err != nil {
		t.Fatal("rsi-store-project", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase)
		VALUES('eval-task','eval-project','eval',1,0,1,'chatting')`); err != nil {
		t.Fatal("rsi-store-task", err)
	}
	return store, func() { store.Close() }
}

func gitIn(root string, args ...string) (string, error) {
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func rsiCases() []Case {
	return []Case{
		{
			Name:     "rsi-resolves-checks-applies-and-commits",
			Group:    "rsi",
			Layer:    LayerIntegration,
			Contract: "ResolveRsiRoot finds the configured checkout, the service reports it available, and Apply writes a change, runs the checks and commits it to the fixture repo",
			Run: func(t *T) {
				repo := newRsiRepo(t, map[string]string{"note.txt": "before\n"})
				defer os.RemoveAll(filepath.Dir(repo.Root))

				root := graph.ResolveRsiRoot(map[string]string{"GRAPH_RSI_ROOT": repo.Root}, t.TempDirPath())
				t.True("rsi-root.resolved", root != nil)
				if root == nil {
					return
				}
				t.Equal("rsi-root.path", repo.Root, *root)
				t.Equal("rsi-root.detects-git", repo.Root, renderPtr(graph.DetectRepo(repo.Root)))

				service := graph.NewRsiService(graph.RsiServiceOptions{Root: root, StateDir: repo.StateDir})
				t.True("rsi-service.available", service.Available)
				status := service.Status(false)
				t.True("rsi-status.available", status.Available)
				t.Equal("rsi-status.branch", "main", renderPtr(status.Branch))

				checks := 0
				store, closeStore := newRsiStore(t, repo.StateDir)
				defer closeStore()
				service = graph.NewRsiService(graph.RsiServiceOptions{
					Root:     root,
					StateDir: repo.StateDir,
					Validate: func(input graph.RsiValidateInput) []graph.RsiValidationResult {
						checks++
						t.Equal("rsi-validate.root", repo.Root, input.Root)
						return []graph.RsiValidationResult{{Command: "eval-fixture-check", Status: "passed"}}
					},
				})
				receipt := service.Apply(map[string]any{
					"title":   "eval fixture change",
					"problem": "the fixture note is stale",
					"changes": []any{
						map[string]any{"path": "note.txt", "action": "write", "content": "after\n"},
					},
				}, graph.RsiApplyContext{Store: store, TaskId: "eval-task"})
				t.Equal("rsi-apply.status", "applied", receipt.Status)
				t.True("rsi-apply.ran-checks", checks > 0)
				t.True("rsi-apply.has-commit", receipt.Commit != nil)
				t.NotEmpty("rsi-apply.files", receipt.Files)
				t.True("rsi-apply.requires-restart", receipt.RestartRequired)

				written, err := os.ReadFile(filepath.Join(repo.Root, "note.txt"))
				if err != nil {
					t.Fatal("rsi-apply.read-back", err)
				}
				t.Equal("rsi-apply.wrote-the-file", "after\n", string(written))

				head, err := gitIn(repo.Root, "log", "-1", "--format=%s")
				if err != nil {
					t.Fatal("rsi-apply.log", err)
				}
				t.Equal("rsi-apply.commit-subject", "rsi: eval fixture change", head)
				changed, err := gitIn(repo.Root, "show", "--name-only", "--format=", "HEAD")
				if err != nil {
					t.Fatal("rsi-apply.show", err)
				}
				t.Equal("rsi-apply.commit-carries-the-file", "note.txt", changed)
				if receipt.Commit != nil {
					headSha, shaErr := gitIn(repo.Root, "rev-parse", "HEAD")
					if shaErr != nil {
						t.Fatal("rsi-apply.rev-parse", shaErr)
					}
					t.Equal("rsi-apply.commit-is-head", headSha, renderPtr(receipt.Commit))
				}
			},
		},
		{
			Name:     "rsi-refuses-a-path-outside-the-checkout",
			Group:    "rsi",
			Layer:    LayerIntegration,
			Contract: "Apply rejects a change whose path escapes the resolved root instead of writing outside it",
			Run: func(t *T) {
				repo := newRsiRepo(t, map[string]string{"note.txt": "before\n"})
				defer os.RemoveAll(filepath.Dir(repo.Root))
				root := graph.ResolveRsiRoot(map[string]string{"GRAPH_RSI_ROOT": repo.Root}, t.TempDirPath())
				if root == nil {
					t.Fatal("rsi-root.resolved", fmt.Errorf("the fixture checkout did not resolve"))
				}
				store, closeStore := newRsiStore(t, repo.StateDir)
				defer closeStore()
				service := graph.NewRsiService(graph.RsiServiceOptions{
					Root:     root,
					StateDir: repo.StateDir,
					Validate: func(graph.RsiValidateInput) []graph.RsiValidationResult {
						return []graph.RsiValidationResult{{Command: "eval-fixture-check", Status: "passed"}}
					},
				})
				recovered := ""
				func() {
					defer func() {
						if value := recover(); value != nil {
							recovered = fmt.Sprint(value)
						}
					}()
					service.Apply(map[string]any{
						"title":   "escape the checkout",
						"problem": "the path must not leave the root",
						"changes": []any{
							map[string]any{"path": "../outside.txt", "action": "write", "content": "nope\n"},
						},
					}, graph.RsiApplyContext{Store: store, TaskId: "eval-task"})
				}()
				t.True("rsi-escape.rejected", recovered != "")
				if _, err := os.Stat(filepath.Join(filepath.Dir(repo.Root), "outside.txt")); !os.IsNotExist(err) {
					t.Fatal("rsi-escape.wrote-outside", fmt.Errorf("the change escaped the resolved root"))
				}
				head, err := gitIn(repo.Root, "log", "-1", "--format=%s")
				if err != nil {
					t.Fatal("rsi-escape.log", err)
				}
				t.Equal("rsi-escape.no-commit", "fixture", head)
			},
		},
		{
			Name:     "rsi-keeps-changes-when-checks-fail",
			Group:    "rsi",
			Layer:    LayerIntegration,
			Contract: "Apply with failing checks leaves the change in the worktree, reports the failure, and does not commit",
			Run: func(t *T) {
				repo := newRsiRepo(t, map[string]string{"note.txt": "before\n"})
				defer os.RemoveAll(filepath.Dir(repo.Root))
				root := graph.ResolveRsiRoot(map[string]string{"GRAPH_RSI_ROOT": repo.Root}, t.TempDirPath())
				if root == nil {
					t.Fatal("rsi-root.resolved", fmt.Errorf("the fixture checkout did not resolve"))
				}
				service := graph.NewRsiService(graph.RsiServiceOptions{
					Root:     root,
					StateDir: repo.StateDir,
					Validate: func(graph.RsiValidateInput) []graph.RsiValidationResult {
						return []graph.RsiValidationResult{{Command: "eval-fixture-check", Status: "failed", Output: "boom"}}
					},
				})
				store, closeStore := newRsiStore(t, repo.StateDir)
				defer closeStore()
				receipt := service.Apply(map[string]any{
					"title":   "change with failing checks",
					"problem": "the check rejects this change",
					"changes": []any{
						map[string]any{"path": "note.txt", "action": "write", "content": "pending\n"},
					},
				}, graph.RsiApplyContext{Store: store, TaskId: "eval-task"})
				t.Equal("rsi-failed-checks.status", "checks_failed", receipt.Status)
				t.True("rsi-failed-checks.has-no-commit", receipt.Commit == nil)
				t.NotEmpty("rsi-failed-checks.pending-files", receipt.PendingFiles)
				head, err := gitIn(repo.Root, "log", "-1", "--format=%s")
				if err != nil {
					t.Fatal("rsi-failed-checks.log", err)
				}
				t.Equal("rsi-failed-checks.did-not-commit", "fixture", head)
				written, err := os.ReadFile(filepath.Join(repo.Root, "note.txt"))
				if err != nil {
					t.Fatal("rsi-failed-checks.read-back", err)
				}
				t.Equal("rsi-failed-checks.kept-the-change", "pending\n", string(written))
			},
		},
	}
}
