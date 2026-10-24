package graph

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// A `workspace.command` operation reads code out of the integration worktree, so it may only be
// admitted once the delivery's causal commit is really in that tree. An execution being `completed`
// is not that fact: a source that submitted and then failed to merge has an output but no
// integration, and a source that is still running has not merged yet.
//
// Only this action is gated, and only in the integration copy: agents, ordinary modules, `each`
// routers, immediate delivery and graphs without Git keep their own timing. Nothing is inferred
// into the protocol value - the delivery keeps exactly the value its producer emitted, and the
// operation's own receipt still names the commit it read.

// ModuleOperationProgram is the program declaration one operation runs under.
type ModuleOperationProgram struct {
	ReadPaths       []string
	Env             map[string]string
	NodeModulesPath *string
}

// ModuleOperationInput is one module operation to execute.
type ModuleOperationInput struct {
	Kernel           *KernelStore
	GraphId          string
	ModuleId         string
	DeliveryId       string
	RevisionVersion  int
	Operation        *ModuleOperation
	Workspace        string
	ScratchRoot      string
	IntegratesSource func(executionId string) bool
	State            any
	Inputs           map[string]any
	Access           *ResolvedAccessPolicy
	Signal           *AbortSignal
	Program          *ModuleOperationProgram
}

// moduleOperationRecord is the durable record of one dispatched operation.
type moduleOperationRecord struct {
	OperationId    string                           `json:"operationId"`
	Command        string                           `json:"command"`
	Args           []string                         `json:"args"`
	Code           *int                             `json:"code"`
	Stdout         string                           `json:"stdout"`
	Stderr         string                           `json:"stderr"`
	OutputFiles    map[string]HostCommandOutputFile `json:"outputFiles,omitempty"`
	Commit         *string                          `json:"commit"`
	CommitAfter    *string                          `json:"commitAfter"`
	CleanBefore    bool                             `json:"cleanBefore"`
	CleanAfter     bool                             `json:"cleanAfter"`
	VerifiedCommit *string                          `json:"verifiedCommit"`
	Sandboxed      bool                             `json:"sandboxed"`
	ElapsedMs      int64                            `json:"elapsedMs"`
}

// moduleOperationOutput is the value the operation publishes under its output name.
type moduleOperationOutput struct {
	Passed         bool                             `json:"passed"`
	Code           *int                             `json:"code"`
	Commit         *string                          `json:"commit"`
	VerifiedCommit *string                          `json:"verifiedCommit"`
	Record         string                           `json:"record"`
	OperationId    string                           `json:"operationId"`
	OutputFiles    map[string]HostCommandOutputFile `json:"outputFiles,omitempty"`
	Stdout         string                           `json:"stdout"`
	Stderr         string                           `json:"stderr"`
	ElapsedMs      int64                            `json:"elapsedMs"`
}

// moduleOperationEvaluated is the settled result of one operation, as it is stored.
type moduleOperationEvaluated struct {
	Ok          bool           `json:"ok"`
	State       any            `json:"state"`
	Outputs     map[string]any `json:"outputs"`
	Diagnostics []string       `json:"diagnostics"`
}

// moduleOperationOutputValue renders one operation output as the plain JSON object
// the protocol validators and the module's outputs see.
func moduleOperationOutputValue(output moduleOperationOutput) map[string]any {
	raw, err := json.Marshal(output)
	if err != nil {
		panic(err)
	}
	value := map[string]any{}
	if err := json.Unmarshal(raw, &value); err != nil {
		panic(err)
	}
	return value
}

// rsiDecodeModuleOperation reads a settled operation result.
func rsiDecodeModuleOperation(value any) ModuleOperationResponse {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var response ModuleOperationResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		panic(err)
	}
	return response
}

// rsiModuleTail keeps the last characters of one stream.
func rsiModuleTail(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[len(runes)-limit:])
}

// rsiAdmitSource refuses a workspace.command that would read code the integration tree does not hold.
func rsiAdmitSource(kernel *KernelStore, graphID, deliveryID, workspace string, operation *ModuleOperation, integratesSource func(string) bool) {
	if operation == nil || operation.Action != "workspace.command" {
		return
	}
	task := kernel.Store.Task(graphID)
	if task.IntegrationBranch == nil || *task.IntegrationBranch == "" {
		return
	}
	integration := kernelRow(kernel.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+graphID)
	if integration == nil {
		return
	}
	if deployResolve("", graphDBString(integration, "path")) != deployResolve("", workspace) {
		return
	}
	executionID, sourceState, found := kernel.DeliverySource(deliveryID)
	if !found {
		return
	}
	// Main-delivered and module-to-module input has no causal producer to wait for.
	if executionID == nil {
		return
	}
	// Whether this source owes the integration branch a commit is a production fact (its frozen recipe,
	// its admitted work location), not the absence of a commit row - a node may submit first and be
	// committed automatically at settle. The host answers it; a commit row cannot.
	integrates := false
	if integratesSource != nil {
		integrates = integratesSource(*executionID)
	} else {
		integrates = kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='instance'", graphID, *executionID) != nil
	}
	if !integrates {
		return
	}
	merged := kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='integration'", graphID, *executionID)
	if merged == nil {
		// A short wait, not a repair: the delivery stays pending and the same one is retried.
		if sourceState == "running" {
			Raise("paused", "Delivery source "+*executionID+" has not been integrated yet")
		}
		Raise("integration_blocked", "Delivery source "+*executionID+" did not reach the integration branch")
	}
	produced := kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='instance'", graphID, *executionID)
	if produced != nil {
		sha := graphDBString(produced, "sha")
		if Git(workspace, []string{"merge-base", "--is-ancestor", sha, "HEAD"}, nil, nil).Code != 0 {
			Raise("integration_blocked", "Delivery source "+*executionID+" produced "+sha+", which the integration worktree does not contain")
		}
	}
}

// ExecuteModuleOperation runs one module operation and returns what it published.
//
// Host operations keep a durable send boundary; replaying a result never re-runs its command.
func ExecuteModuleOperation(options ModuleOperationInput) ModuleOperationResponse {
	kernel := options.Kernel
	operation := options.Operation
	previous := kernel.ModuleOperationOfDelivery(options.DeliveryId)
	if previous != nil {
		switch previous.State {
		case "settled":
			return rsiDecodeModuleOperation(kernel.Content.Decode(previous.Result))
		case "cancelled":
			Raise("invalid_operation", "Cancelled operation input cannot be replayed; send a new input explicitly")
		case "dispatched", "uncertain":
			Raise("uncertain_operation", "Operation "+previous.Id+" may have side effects; reconcile or cancel it before retrying")
		}
	}
	if operation == nil {
		Raise("invalid_operation", "Operation is no longer dispatchable")
	}
	if operation.Sandbox != nil && !*operation.Sandbox && (options.Access == nil || options.Access.Mode != "full") {
		Raise("permission", "workspace.command sandbox:false requires full access")
	}
	id := graphUUID()
	if previous != nil {
		id = previous.Id
	}
	created := NowMillis()
	kernel.Store.Transaction(func() any {
		request := kernel.Content.Encode(map[string]any{
			"operation": operation, "inputs": options.Inputs, "workspace": options.Workspace,
		})
		kernel.PrepareModuleOperation(id, options.GraphId, options.ModuleId, options.DeliveryId, options.RevisionVersion, request, created)
		return nil
	})

	var commit *string
	cleanBefore := false
	cleanTree := func() bool {
		status := Git(options.Workspace, []string{"status", "--porcelain", "-u"}, nil, nil)
		return status.Code == 0 && strings.TrimSpace(status.Stdout) == ""
	}
	admit := func() {
		task := kernel.Store.Task(options.GraphId)
		if task.Paused != 0 || (options.Signal != nil && options.Signal.Aborted()) || phaseClosed(task.Phase) {
			Raise("paused", "Graph operation dispatch is closed")
		}
		if kernel.NodeState(options.GraphId, options.ModuleId).Paused {
			Raise("paused", "Module is paused")
		}
		rsiAdmitSource(kernel, options.GraphId, options.DeliveryId, options.Workspace, operation, options.IntegratesSource)
		commit = RevParse(options.Workspace, "HEAD")
		cleanBefore = commit != nil && cleanTree()
		dispatched, err := kernel.DispatchModuleOperation(id)
		if err != nil {
			panic(err)
		}
		if !dispatched {
			Raise("invalid_operation", "Operation is no longer dispatchable")
		}
	}

	scratchDir := filepath.Join(options.ScratchRoot, "module-operations", id)
	if err := os.MkdirAll(scratchDir, 0o700); err != nil {
		panic(err)
	}
	cancellation := NewAbortSignal()
	abort := func() { cancellation.Abort() }
	var abortListener *abortListener
	if options.Signal != nil {
		if options.Signal.Aborted() {
			abort()
		} else {
			abortListener = options.Signal.AddEventListener("abort", abort, true)
		}
	}
	unsubscribe := kernel.Store.OnEvent(func(string) {
		phase := kernel.Store.Task(options.GraphId).Phase
		if phase == "stopping" || phase == "stopped" {
			abort()
		}
	})
	dispatched := func() {
		kernel.Store.Event(options.GraphId, "graph.operation.dispatched", map[string]any{
			"moduleId": options.ModuleId, "operationId": id, "deliveryId": options.DeliveryId,
		})
	}
	var runner *WorkspaceCommandRunner
	defer func() {
		unsubscribe()
		if options.Signal != nil {
			options.Signal.RemoveEventListener(abortListener)
		}
		if runner != nil {
			runner.Close()
		}
		kernel.ReleaseModuleOperationWorker(id)
	}()
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		cancellation.Abort()
		reason := rsiPanicMessage(recovered)
		unsentPause := false
		if failure, ok := recovered.(*RuntimeError); ok && failure.Code == "paused" &&
			kernel.ModuleOperationPrepared(id) {
			unsentPause = true
		}
		if !unsentPause {
			kernel.FailModuleOperation(id, reason, NowMillis())
		}
		panic(recovered)
	}()

	WaitForKernelProgramExecutionSlot(kernel, id, cancellation)
	var programEnv map[string]string
	var programReadPaths []string
	var nodeModulesPath *string
	if options.Program != nil {
		programEnv = options.Program.Env
		programReadPaths = options.Program.ReadPaths
		nodeModulesPath = options.Program.NodeModulesPath
	}
	modules := LinkProjectDependencies(options.Workspace, nodeModulesPath)
	candidates := append([]string{}, programReadPaths...)
	if modules != nil {
		candidates = append(candidates, *modules)
	}
	readPaths := []string{}
	for _, path := range candidates {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			readPaths = append(readPaths, resolved)
		}
	}
	timeoutMs := 120_000
	if operation.TimeoutMs != nil {
		timeoutMs = *operation.TimeoutMs
	}
	var result HostCommandResult
	if operation.Sandbox != nil && !*operation.Sandbox {
		command := ResolveUnsandboxedCommand(operation.Command, operation.Args)
		nonce := graphUUID()
		quiescence := ProcessQuiescenceReceipt{Path: filepath.Join(scratchDir, "quiescence-"+nonce+".json"), Nonce: nonce}
		kernel.RecordModuleOperationReceipt(id, CanonicalJSON(quiescence))
		declared := map[string]string{}
		for key, value := range programEnv {
			declared[key] = value
		}
		for key, value := range command.Env {
			declared[key] = value
		}
		outputDir := scratchDir
		running := RunHostCommand(HostCommandInput{
			Cwd: options.Workspace, Executable: command.Executable, Args: command.Args,
			OutputDir: &outputDir,
			Env:       CheckEnvironment(CheckEnvironmentInput{Executable: command.Executable, Host: environMap(), Declared: declared}),
			TimeoutMs: &timeoutMs, Signal: cancellation, Quiescence: &quiescence,
			BeforeStart: func() { admit(); dispatched() },
		})
		result = running
	} else {
		environment := map[string]string{}
		for key, value := range programEnv {
			environment[key] = value
		}
		temporary, hasTemporary := environment["TMPDIR"]
		if !hasTemporary {
			resolved, err := filepath.EvalSymlinks(scratchDir)
			if err != nil {
				resolved = scratchDir
			}
			temporary = resolved
		}
		environment["TMPDIR"] = temporary
		runner = OpenWorkspaceCommandRunner(options.Workspace, scratchDir, SendGate{
			Dispatch: func(_ string, _ float64, send func() any) any {
				admit()
				started := send()
				dispatched()
				return started
			},
			Settle: func(string, *TokenUsage) {},
		}, readPaths, environment, true, options.Access, true, timeoutMs)
		command := runner.Run(operation.Command, operation.Args, cancellation)
		result = HostCommandResult{Code: command.Code, Stdout: command.Stdout, Stderr: command.Stderr}
	}
	if cancellation.Aborted() {
		Raise("uncertain_operation", "Operation interrupted after dispatch; inspect its side effects before continuing")
	}
	commitAfter := RevParse(options.Workspace, "HEAD")
	cleanAfter := commitAfter != nil && cleanTree()
	var verifiedCommit *string
	if result.Code != nil && *result.Code == 0 && commit != nil && commitAfter != nil && *commit == *commitAfter && cleanBefore && cleanAfter {
		verifiedCommit = commit
	}
	record := moduleOperationRecord{
		OperationId: id, Command: operation.Command, Args: operation.Args,
		Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr, OutputFiles: result.OutputFiles,
		Commit: commit, CommitAfter: commitAfter, CleanBefore: cleanBefore, CleanAfter: cleanAfter,
		VerifiedCommit: verifiedCommit, Sandboxed: operation.Sandbox == nil || *operation.Sandbox,
		ElapsedMs: NowMillis() - created,
	}
	recordPath := filepath.Join(scratchDir, "result.json")
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(record); err != nil {
		panic(err)
	}
	recordBytes := buffer.Bytes()
	if err := os.WriteFile(recordPath, recordBytes, 0o600); err != nil {
		panic(err)
	}
	sum := sha256.Sum256(recordBytes)
	recordDigest := hex.EncodeToString(sum[:])
	output := moduleOperationOutput{
		Passed: result.Code != nil && *result.Code == 0, Code: result.Code,
		Commit: commit, VerifiedCommit: verifiedCommit, Record: recordPath, OperationId: id,
		OutputFiles: result.OutputFiles,
		Stdout:      rsiModuleTail(result.Stdout, 32_768), Stderr: rsiModuleTail(result.Stderr, 32_768),
		ElapsedMs: record.ElapsedMs,
	}
	evaluated := moduleOperationEvaluated{
		Ok: true, State: options.State,
		// The published value is a plain JSON object: it travels into the module's
		// outputs, and the protocol validator reads a JSON object there, not a
		// Go struct.
		Outputs:     map[string]any{operation.Output: moduleOperationOutputValue(output)},
		Diagnostics: []string{"workspace.command " + id},
	}
	kernel.Store.Transaction(func() any {
		kernel.SettleModuleOperation(id, kernel.Content.Encode(evaluated), recordDigest, NowMillis())
		return nil
	})
	kernel.Store.Event(options.GraphId, "graph.operation.settled", map[string]any{
		"moduleId": options.ModuleId, "operationId": id, "passed": output.Passed,
		"commit": commit, "verifiedCommit": verifiedCommit, "record": recordPath,
	})
	return ModuleOperationResponse{
		Ok: evaluated.Ok, State: evaluated.State, Outputs: evaluated.Outputs, Diagnostics: evaluated.Diagnostics,
	}
}
