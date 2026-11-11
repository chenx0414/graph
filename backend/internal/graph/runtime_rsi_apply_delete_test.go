// graph:table-writes-exempt: no table is written by this test
package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func rsiApplyRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", root}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
		return strings.TrimSpace(string(output))
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte("{\"name\":\"fixture\"}\n"), 0o600); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	for path, content := range files {
		absolute := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(absolute, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	run("init", "-q", "-b", "main")
	run("config", "user.email", "graph@example.invalid")
	run("config", "user.name", "Graph Test")
	run("add", "-A")
	run("commit", "-q", "-m", "fixture")
	return root
}

func rsiApplyReceipt(t *testing.T, root string, changes []any) RsiReceipt {
	t.Helper()
	store, closeStore := newDeferredTestStore(t)
	defer closeStore()
	stateDir := t.TempDir()
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p',?,'[]')", root)
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task-fixture','p','r',1,0,1,'chatting')")
	service := NewRsiService(RsiServiceOptions{
		Root:     &root,
		StateDir: stateDir,
		Validate: func(RsiValidateInput) []RsiValidationResult {
			return []RsiValidationResult{{Command: "go -C backend run ./cmd/graphcheck all", Status: "passed"}}
		},
	})
	if !service.Available {
		t.Fatalf("the fixture repository is not an available RSI root")
	}
	return service.Apply(map[string]any{
		"title":   "fixture change",
		"problem": "the fixture repository is missing a file",
		"changes": changes,
	}, RsiApplyContext{TaskId: "task-fixture", Store: store})
}

func TestADeletedFileIsCommittedWhenTheChangeOnlyDeletes(t *testing.T) {
	root := rsiApplyRepo(t, map[string]string{"note.txt": "keep me\n", "old/gone.txt": "remove me\n"})
	receipt := rsiApplyReceipt(t, root, []any{
		map[string]any{"path": "old/gone.txt", "action": "delete"},
	})
	if receipt.Status != "applied" || receipt.Commit == nil {
		t.Fatalf("a delete-only change produced no commit: status=%q commit=%v error=%v", receipt.Status, receipt.Commit, receipt.Error)
	}
	tree := exec.Command("git", "-C", root, "show", "--name-status", "--format=", "HEAD")
	output, err := tree.CombinedOutput()
	if err != nil {
		t.Fatalf("git show: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "D\told/gone.txt") {
		t.Fatalf("the commit does not delete the file:\n%s", output)
	}
	if _, err := os.Stat(filepath.Join(root, "old", "gone.txt")); !os.IsNotExist(err) {
		t.Fatalf("the deleted file is still on disk")
	}
}

func TestADeletedFileIsCommittedAlongsideAWrittenFile(t *testing.T) {
	root := rsiApplyRepo(t, map[string]string{"note.txt": "old\n", "old/gone.txt": "remove me\n"})
	receipt := rsiApplyReceipt(t, root, []any{
		map[string]any{"path": "note.txt", "action": "write", "content": "new\n"},
		map[string]any{"path": "old/gone.txt", "action": "delete"},
	})
	if receipt.Status != "applied" || receipt.Commit == nil {
		t.Fatalf("a mixed change produced no commit: status=%q commit=%v error=%v", receipt.Status, receipt.Commit, receipt.Error)
	}
	tree := exec.Command("git", "-C", root, "show", "--name-status", "--format=", "HEAD")
	output, err := tree.CombinedOutput()
	if err != nil {
		t.Fatalf("git show: %v\n%s", err, output)
	}
	text := string(output)
	if !strings.Contains(text, "D\told/gone.txt") || !strings.Contains(text, "M\tnote.txt") {
		t.Fatalf("the commit does not carry both the deletion and the write:\n%s", text)
	}
}

func TestADeletionAlreadyStagedByHandStillReachesTheCommit(t *testing.T) {
	root := rsiApplyRepo(t, map[string]string{"note.txt": "keep me\n", "old/gone.txt": "remove me\n"})
	if output, err := exec.Command("git", "-C", root, "rm", "-q", "old/gone.txt").CombinedOutput(); err != nil {
		t.Fatalf("git rm: %v\n%s", err, output)
	}
	receipt := rsiApplyReceipt(t, root, []any{
		map[string]any{"path": "old/gone.txt", "action": "delete"},
	})
	if receipt.Status != "applied" || receipt.Commit == nil {
		detail := ""
		if receipt.Error != nil {
			detail = *receipt.Error
		}
		t.Fatalf("a hand-staged deletion produced no commit: status=%q commit=%v error=%s", receipt.Status, receipt.Commit, detail)
	}
	output, err := exec.Command("git", "-C", root, "show", "--name-status", "--format=", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("git show: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "D\told/gone.txt") {
		t.Fatalf("the commit dropped the hand-staged deletion:\n%s", output)
	}
}

func TestAnUntrackedFileOnDiskIsCommittedNotLeftStaged(t *testing.T) {
	root := rsiApplyRepo(t, map[string]string{"note.txt": "keep me\n"})
	if err := os.WriteFile(filepath.Join(root, "keeper.txt"), []byte("keeper content\n"), 0o600); err != nil {
		t.Fatalf("write keeper.txt: %v", err)
	}
	receipt := rsiApplyReceipt(t, root, []any{
		map[string]any{"path": "note.txt", "action": "write", "content": "changed\n"},
		map[string]any{"path": "keeper.txt", "action": "write", "fromPath": "keeper.txt"},
	})
	if receipt.Status != "applied" || receipt.Commit == nil {
		t.Fatalf("the change produced no commit: status=%q commit=%v", receipt.Status, receipt.Commit)
	}
	output, err := exec.Command("git", "-C", root, "show", "--pretty=format:", "--name-only", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("git show: %v\n%s", err, output)
	}
	names := strings.Fields(string(output))
	if len(names) != 2 || names[0] != "keeper.txt" && names[1] != "keeper.txt" {
		t.Fatalf("the commit does not carry the untracked file: %v", names)
	}
	status, err := exec.Command("git", "-C", root, "status", "--porcelain").CombinedOutput()
	if err != nil {
		t.Fatalf("git status: %v\n%s", err, status)
	}
	if strings.TrimSpace(string(status)) != "" {
		t.Fatalf("the change left work staged or dirty:\n%s", status)
	}
}
