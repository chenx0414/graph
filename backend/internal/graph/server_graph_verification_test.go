package graph

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGraphVerificationPublishesFailureAndPassForTheSameCheck(t *testing.T) {
	for _, scenario := range []struct {
		name, baseline, status string
		changeVerification     bool
	}{
		{name: "preserved", baseline: "expected", status: "passed"},
		{name: "green only", status: "missing"},
		{name: "wrong failure", baseline: "unrelated", status: "missing"},
		{name: "implementation in baseline", baseline: "mixed", status: "missing"},
		{name: "verifier rewritten", baseline: "expected", changeVerification: true, status: "stale"},
		{name: "target advanced after delivery", baseline: "delivered", status: "passed"},
		{name: "different checkout", baseline: "wrong checkout", status: "missing"},
		{name: "uncommitted verifier hidden from git status", baseline: "hidden edit", status: "passed"},
		{name: "uncommitted fix hidden from git status", baseline: "hidden product", status: "failed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			verifyGraphDelivery(t, scenario.baseline, scenario.status, scenario.changeVerification)
		})
	}
}

func TestImplementationRequiresTheExpectedFailureBeforeDispatch(t *testing.T) {
	verifyGraphDelivery(t, "staged", "passed", false)
}

func verifyGraphDelivery(t *testing.T, baseline, expected string, changeVerification bool) {
	t.Helper()
	repo := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	git := func(args ...string) string {
		t.Helper()
		result := Git(repo, args, nil, nil)
		if result.Code != 0 {
			t.Fatalf("git %v: %s", args, result.Stderr)
		}
		return result.Stdout
	}
	commit := func(message string) string {
		t.Helper()
		git("add", ".")
		git("commit", "-m", message)
		return git("rev-parse", "HEAD")
	}
	git("init", "-b", "main")
	write("product.txt", "old\n")

	staged := baseline == "staged"
	definition := verificationTestDefinition(t, staged)

	store := openTaskStore(t, filepath.Join(t.TempDir(), "graph.sqlite"))
	t.Cleanup(store.Close)
	store.RegisterProject("p1", repo, "[]")
	store.SetExecutionLimits(2, 2)
	kernel := NewKernelStore(store)
	graphID := "verify-graph"
	graph := NewGraphRuntime(kernel, graphID, nil)
	created := graph.Create(definition, "", "p1")
	kernel.AdmitModule(graphID, created.Revision.Version, "check", AdmitModuleInput{ModuleType: "operation", Trigger: "each"})
	if staged {
		kernel.AdmitNode(graphID, created.Revision.Version, "implement", AdmitNodeInput{InstanceId: "implementer"})
	}
	target := commit("Original product")
	store.SetTaskIntegration(graphID, "main", target, target)
	integration := repo
	if baseline == "wrong checkout" {
		integration = t.TempDir()
	}
	AddIntegrationWorktree(store, graphID, integration, "main")
	app := CreateApp(&TaskRuntime{store: store, kernel: kernel}, AppOptions{})
	scratch := t.TempDir()
	manager := NewGraphManagement(kernel, graphID, nil, nil)
	var operationID string
	host := &verificationTestHost{}
	runner := NewGraphRunner(GraphRunnerOptions{
		Kernel: kernel, GraphId: graphID,
		HostFor: func(string, int) ExecutorHost { return host },
		Operation: func(request ModuleOperationRequest) ModuleOperationResponse {
			result := ExecuteModuleOperation(ModuleOperationInput{
				Kernel: kernel, GraphId: graphID, ModuleId: request.ModuleId, DeliveryId: request.DeliveryId,
				RevisionVersion: request.RevisionVersion, Operation: request.Operation, Inputs: request.Inputs,
				State: request.State, Signal: request.Signal, Workspace: repo, ScratchRoot: scratch,
			})
			if output, ok := result.Outputs["result"].(map[string]any); ok {
				operationID, _ = output["operationId"].(string)
			}
			return result
		},
	})
	run := func(sha string) string {
		t.Helper()
		store.SetTaskIntegrationSha(graphID, sha)
		input := "verify"
		manager.GraphSend(GraphSendInput{GraphId: graphID, Input: &input, Value: map[string]any{}})
		operationID = ""
		if outcome := runner.Drain(); !outcome.Drained || operationID == "" {
			t.Fatalf("host did not settle the check: %+v", outcome)
		}
		return operationID
	}
	read := func() verificationEvidenceView {
		t.Helper()
		response := topologyRequest(t, app, "/api/tasks/"+graphID+"/graph/topology")
		if response.Code != http.StatusOK {
			t.Fatalf("topology: %d %s", response.Code, response.Body)
		}
		var view struct {
			Verification []verificationEvidenceView
		}
		if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil || len(view.Verification) != 1 {
			t.Fatalf("topology must return one verification item: %v %s", err, response.Body)
		}
		return view.Verification[0]
	}

	implementationInput := func() {
		node, port := "implement", "job"
		manager.GraphSend(GraphSendInput{GraphId: graphID, NodeId: &node, Input: &port, Value: map[string]any{}})
	}
	assertBlocked := func() {
		t.Helper()
		for _, dispatch := range []func(){implementationInput, func() {
			SendKernelNodeMessage(kernel, graphID, "implement", NodeMessageInput{Text: "Implement now", RequestID: "early-chat"}, nil)
		}} {
			err := portRecover(dispatch)
			if err == nil || !strings.Contains(err.Error(), "failing baseline") {
				t.Fatalf("implementation requires a failing baseline, got %v", err)
			}
		}
		queue := "queue"
		if got := manager.GraphInspect(GraphInspectInput{GraphId: graphID, Query: &queue}).(QueueHistoryPage); len(got.Items) != 0 {
			t.Fatalf("refused work must leave no execution queued: %+v", got)
		}
	}
	if staged {
		assertBlocked()
	}

	script := "if test \"$(cat product.txt)\" = new; then exit 0; fi\necho %q\nexit 42\n"
	message := "wanted the new value"
	if baseline == "unrelated" {
		message = "tool unavailable"
	}
	if staged {
		write("verify.sh", "echo tool unavailable\nexit 42\n")
		run(commit("Unrelated failure"))
		assertBlocked()
	}
	write("verify.sh", fmt.Sprintf(script, message))
	var redID, redCommit string
	if baseline != "" {
		if baseline == "mixed" {
			write("product.txt", "still old\n")
		}
		redCommit = commit("Define the check")
		redID = run(redCommit)
		if baseline == "expected" || staged {
			evidence := read()
			if evidence.Baseline == nil || evidence.Baseline.Id != redID || evidence.Baseline.Commit != redCommit {
				t.Fatalf("baseline receipt = %+v, want operation %s at %s", evidence.Baseline, redID, redCommit)
			}
		}
	}
	if staged {
		if err := portRecover(implementationInput); err != nil {
			t.Fatalf("the expected baseline must unlock implementation: %v", err)
		}
		if outcome := runner.Drain(); !outcome.Drained || !strings.Contains(host.prompt, redCommit) || !strings.Contains(host.prompt, redID) {
			t.Fatalf("the implementation agent should receive the actual failing baseline and its receipt: %+v, %q", outcome, host.prompt)
		}
	}

	if changeVerification {
		write("verify.sh", "exit 0\n")
	}
	product := "new\n"
	if baseline == "hidden product" {
		product = "still old\n"
	}
	write("product.txt", product)
	greenCommit := commit("Implement the contract")
	if baseline == "hidden edit" {
		git("update-index", "--assume-unchanged", "verify.sh")
		write("verify.sh", "exit 0\n")
		if status := git("status", "--porcelain", "-u"); status != "" {
			t.Fatalf("fixture must hide the edit from status: %q", status)
		}
	}
	if baseline == "hidden product" {
		git("update-index", "--assume-unchanged", "product.txt")
		write("product.txt", "new\n")
	}
	greenID := run(greenCommit)
	if baseline == "delivered" {
		store.SetTaskTargetSha(graphID, greenCommit)
	}
	evidence := read()
	if evidence.Status != expected {
		t.Fatalf("verification status = %q, want %q (%s)", evidence.Status, expected, evidence.Reason)
	}
	if expected == "passed" && (evidence.Source == nil || evidence.Source.Id != greenID || evidence.Source.Commit != greenCommit ||
		evidence.Baseline == nil || evidence.Baseline.Id != redID || evidence.Baseline.Commit != redCommit) {
		t.Fatalf("passing evidence must cite both exact operations and commits: %+v", evidence)
	}
	if expected != "passed" {
		manager.GraphControl(GraphControlInput{GraphId: graphID, Action: "complete"})
		if phase := graph.SettleCompletion(); phase != "blocked" {
			t.Fatalf("incomplete verification allowed delivery: %s", phase)
		}
		var refusal any
		func() {
			defer func() { refusal = recover() }()
			manager.WaiveAcceptance(GraphAcceptanceWaiveInput{
				GraphId: graphID, AcceptanceId: "behavior", Reason: "Skip the verification",
				Evidence: "Missing receipt", RequestId: "waive-check",
			})
		}()
		if refusal == nil || !strings.Contains(panicMessage(refusal), "requires both verification receipts") {
			t.Fatalf("verification waiver must be refused: %v", refusal)
		}
	}
}

type verificationEvidenceView struct {
	Status, Reason   string
	Baseline, Source *struct{ Id, Commit string }
}

func verificationTestDefinition(t *testing.T, staged bool) map[string]any {
	t.Helper()
	var definition map[string]any
	if err := json.Unmarshal([]byte(`{
	  "schemaVersion":2,"name":"Verification journey","protocols":{"data":{"type":"object"}},
	  "nodes":{},"edges":{},"inputs":{"verify":{"to":"check.job","protocol":"data"}},"outputs":{},
	  "modules":{"check":{"type":"operation","trigger":"each",
	    "inputs":{"job":{"protocol":"data"}},"outputs":{"result":{"protocol":"data"}},
	    "operation":{"action":"workspace.command","version":1,"command":"sh","args":["verify.sh"],"output":"result","sandbox":false}}},
	  "acceptance":[{"id":"behavior","description":"Read the new value","kind":"check","module":"check",
	    "verification":{"paths":["verify.sh"],"failureText":"wanted the new value"}}]
	}`), &definition); err != nil {
		t.Fatal(err)
	}

	if staged {
		raw := definition
		raw["nodes"] = map[string]any{"implement": map[string]any{
			"recipe": "coder@1", "task": "Set product.txt to new",
			"inputs":  map[string]any{"job": map[string]any{"protocol": "data"}},
			"outputs": map[string]any{}, "submission": map[string]any{},
		}}
		criterion := raw["acceptance"].([]any)[0].(map[string]any)
		criterion["verification"].(map[string]any)["implementationNodes"] = []any{"implement"}
	}

	return definition
}

type verificationTestHost struct {
	prompt string
}

func (host *verificationTestHost) Start() HostProcess { return HostProcess{ProcessId: 1} }
func (host *verificationTestHost) Alive() bool        { return true }
func (host *verificationTestHost) Turn(prompt string) TurnReport {
	host.prompt = prompt
	return TurnReport{Done: true}
}
