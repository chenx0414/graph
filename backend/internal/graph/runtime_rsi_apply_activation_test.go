package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func rsiExistingAppCommit(t *testing.T, options RsiServiceOptions) (*RsiService, RsiApplyContext, string) {
	t.Helper()
	root := rsiApplyRepo(t, map[string]string{"app/main.go": "package main\n"})
	store, closeStore := newDeferredTestStore(t)
	t.Cleanup(closeStore)
	store.RegisterProject("p", root, "[]")
	store.CreateMasterTask("task-fixture", "p", "r", 1)
	options.Root = &root
	options.StateDir = t.TempDir()
	options.Validate = func(RsiValidateInput) []RsiValidationResult {
		return []RsiValidationResult{{Command: "fixture gate", Status: "passed"}}
	}
	service := NewRsiService(options)

	if err := os.WriteFile(filepath.Join(root, "app", "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if result := Git(root, []string{"commit", "-qam", "new app"}, nil, nil); result.Code != 0 {
		t.Fatal(result.Stderr)
	}
	target := RevParse(root, "HEAD")
	if target == nil {
		t.Fatal("missing target commit")
	}
	return service, RsiApplyContext{TaskId: "task-fixture", Store: store}, *target
}

func activateExistingAppCommit(service *RsiService, context RsiApplyContext) RsiReceipt {
	return service.Apply(map[string]any{
		"title":    "Activate existing commit",
		"problem":  "The running app is behind the checkout",
		"activate": true,
		"checks":   []any{map[string]any{"command": "go", "args": []any{"version"}}},
	}, context)
}

func TestRsiActivationOfAnExistingCommitReportsMissingAppAndKeepsQueueOpen(t *testing.T) {
	service, context, target := rsiExistingAppCommit(t, RsiServiceOptions{})
	receipt := activateExistingAppCommit(service, context)
	if receipt.AppInstall == nil || receipt.AppInstall.State != "failed" {
		t.Fatalf("activation must attempt installation and report the missing build, got install=%+v", receipt.AppInstall)
	}
	if !strings.Contains(receipt.Report, "no packaged app") {
		t.Fatalf("activation report omits the installation failure: %s", receipt.Report)
	}
	if receipt.Commit == nil || *receipt.Commit != target {
		t.Fatalf("receipt must retain the verified commit %v, got %v", target, receipt.Commit)
	}
	if receipt.RestartRequired || service.HasPendingRestart() {
		t.Fatal("installation failed, but Graph is waiting for a restart")
	}
	if receipt.Activation == nil || receipt.Activation.State != "saved" {
		t.Fatalf("activation must report the saved commit, got %+v", receipt.Activation)
	}
}

func TestRsiActivationOfAnExistingCommitInstallsBeforeWaitingForReload(t *testing.T) {
	var service *RsiService
	var context RsiApplyContext
	var target string
	service, context, target = rsiExistingAppCommit(t, RsiServiceOptions{
		InstallApp: func(_, buildRoot string) RsiAppInstall {
			if head := RevParse(buildRoot, "HEAD"); head == nil || *head != target {
				t.Fatalf("installer got the wrong build checkout: %q at %v, want %s", buildRoot, head, target)
			}
			if service.HasPendingRestart() {
				t.Fatal("Graph started waiting before the installer returned")
			}
			return RsiAppInstall{State: "installed", Note: "fixture installed"}
		},
	})
	receipt := activateExistingAppCommit(service, context)
	if receipt.AppInstall == nil || receipt.AppInstall.State != "installed" {
		t.Fatalf("missing installation receipt: %+v", receipt.AppInstall)
	}
	if !receipt.RestartRequired || receipt.Activation == nil || receipt.Activation.State != "pending_reload" {
		t.Fatalf("expected pending reload after installation: %+v", receipt)
	}
	pending := service.Status(false).PendingRestart
	if pending == nil || pending.Id != receipt.Id || pending.Commit == nil || *pending.Commit != target {
		t.Fatalf("expected a restart for %s, got %+v", target, pending)
	}
}
