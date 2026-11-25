package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"bytes"
)

type ModuleOperationProgram struct {
	ReadPaths       []string
	Env             map[string]string
	NodeModulesPath *string
}

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
	Signal           *AbortSignal
	Program          *ModuleOperationProgram
}

type moduleOperationRecord struct {
	OperationId     string                           `json:"operationId"`
	Command         string                           `json:"command"`
	Args            []string                         `json:"args"`
	Code            *int                             `json:"code"`
	Stdout          string                           `json:"stdout"`
	Stderr          string                           `json:"stderr"`
	OutputFiles     map[string]HostCommandOutputFile `json:"outputFiles,omitempty"`
	Commit          *string                          `json:"commit"`
	CommitAfter     *string                          `json:"commitAfter"`
	CleanBefore     bool                             `json:"cleanBefore"`
	CleanAfter      bool                             `json:"cleanAfter"`
	VerifiedCommit  *string                          `json:"verifiedCommit"`
	Sandboxed       bool                             `json:"sandboxed"`
	Verdict         string                           `json:"verdict"`
	NoVerdictReason string                           `json:"noVerdictReason,omitempty"`
	TimedOut        bool                             `json:"timedOut"`
	TimeoutMs       int                              `json:"timeoutMs"`
	WaitMs          int64                            `json:"waitMs"`
	ElapsedMs       int64                            `json:"elapsedMs"`
}

type moduleOperationOutput struct {
	Passed          bool                             `json:"passed"`
	Code            *int                             `json:"code"`
	Commit          *string                          `json:"commit"`
	VerifiedCommit  *string                          `json:"verifiedCommit"`
	Record          string                           `json:"record"`
	OperationId     string                           `json:"operationId"`
	OutputFiles     map[string]HostCommandOutputFile `json:"outputFiles,omitempty"`
	Stdout          string                           `json:"stdout"`
	Stderr          string                           `json:"stderr"`
	Verdict         string                           `json:"verdict"`
	NoVerdictReason string                           `json:"noVerdictReason,omitempty"`
	TimedOut        bool                             `json:"timedOut"`
	TimeoutMs       int                              `json:"timeoutMs"`
	WaitMs          int64                            `json:"waitMs"`
	ElapsedMs       int64                            `json:"elapsedMs"`
}

type moduleOperationEvaluated struct {
	Ok                 bool           `json:"ok"`
	State              any            `json:"state"`
	Outputs            map[string]any `json:"outputs"`
	Diagnostics        []string       `json:"diagnostics"`
	VerificationCommit *string        `json:"verificationCommit,omitempty"`
	VerificationTarget *string        `json:"verificationTarget,omitempty"`
}

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

func rsiModuleTail(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[len(runes)-limit:])
}

func moduleOperationAttemptDir(root, operationId string) string {
	base := filepath.Join(root, "module-operations", operationId)
	if err := os.MkdirAll(base, 0o700); err != nil {
		panic(err)
	}
	for attempt := 1; ; attempt++ {
		directory := filepath.Join(base, "attempt-"+itoa(attempt))
		err := os.Mkdir(directory, 0o700)
		if err == nil {
			return directory
		}
		if !errors.Is(err, os.ErrExist) {
			panic(err)
		}
	}
}

func moduleOperationVerdict(code *int) (string, string) {
	if code == nil {
		return "unknown", "no_exit_code"
	}
	if *code == 0 {
		return "passed", ""
	}
	return "failed", ""
}

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
	id := graphUUID()
	if previous != nil {
		id = previous.Id
	}
	created := NowMillis()
	kernel.Store.Transaction(func(tx *TaskStore) any {
		kernel := kernel.scoped(tx)
		request := kernel.Content.Encode(map[string]any{
			"operation": operation, "inputs": options.Inputs, "workspace": options.Workspace,
		})
		kernel.PrepareModuleOperation(id, options.GraphId, options.ModuleId, options.DeliveryId, options.RevisionVersion, request, created)
		return nil
	})

	var commit *string
	var verificationTarget *string
	var verificationSnapshotCommit *string
	commandWorkspace := options.Workspace
	var verificationPaths []string
	if revision := kernel.Revision(options.GraphId, options.RevisionVersion); revision != nil {
		for _, criterion := range revision.Definition.Acceptance {
			if criterion.Module == options.ModuleId && criterion.Verification != nil {
				verificationPaths = append(verificationPaths, criterion.Verification.Paths...)
			}
		}
	}
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
		if verificationSnapshotCommit != nil && cleanBefore && graphAcceptanceShaEqual(commit, task.IntegrationSha) &&
			graphAcceptanceShaEqual(commit, verificationSnapshotCommit) {
			integration := kernelRow(kernel.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+task.ID)
			if integration != nil && gitReal(kernelString(integration["path"])) == gitReal(options.Workspace) &&
				verificationWorkspaceMatches(commandWorkspace, *commit, verificationPaths) {
				verificationTarget = task.TargetSha
			}
		}
		dispatched, err := kernel.DispatchModuleOperation(id)
		if err != nil {
			panic(err)
		}
		if !dispatched {
			Raise("invalid_operation", "Operation is no longer dispatchable")
		}
	}

	scratchDir := moduleOperationAttemptDir(options.ScratchRoot, id)
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
		phase := GraphPhase(kernel.Store.Task(options.GraphId).Phase)
		if phase.Cancelling() {
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

	queued := NowMillis()
	WaitForKernelProgramExecutionSlot(kernel, id, cancellation)
	defer ReleaseKernelProgramExecutionSlot(kernel, id)
	started := NowMillis()
	waitMs := started - queued
	var programEnv map[string]string
	var nodeModulesPath *string
	if options.Program != nil {
		programEnv = options.Program.Env
		nodeModulesPath = options.Program.NodeModulesPath
	}
	if len(verificationPaths) != 0 {
		verificationSnapshotCommit = RevParse(options.Workspace, "HEAD")
		if verificationSnapshotCommit != nil {
			commandWorkspace = filepath.Join(scratchDir, "checkout")
			checkout := verificationGit(options.Workspace, "worktree", "add", "--detach", commandWorkspace, *verificationSnapshotCommit)
			if checkout.Code != 0 {
				Raise("invalid_operation", "Could not check out the verification commit: "+checkout.Stderr)
			}
			defer verificationGit(options.Workspace, "worktree", "remove", "--force", commandWorkspace)
		}
	}
	LinkProjectDependencies(commandWorkspace, nodeModulesPath)
	timeoutMs := moduleOperationDefaultTimeoutMs
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
			Cwd: commandWorkspace, Executable: command.Executable, Args: command.Args,
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
		runner = OpenWorkspaceCommandRunner(commandWorkspace, scratchDir, SendGate{
			Dispatch: func(_ string, _ float64, send func() any) any {
				admit()
				started := send()
				dispatched()
				return started
			},
			Settle: func(string, *TokenUsage) {},
		}, environment, timeoutMs)
		command := runner.Run(operation.Command, operation.Args, cancellation)
		result = HostCommandResult{
			Code: command.Code, Stdout: command.Stdout, Stderr: command.Stderr,
			OutputFiles: hostCommandOutputStreams(scratchDir),
			TimedOut:    strings.Contains(command.Stderr, hostCommandTimeoutMarker(timeoutMs)),
		}
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
	verdict, noVerdictReason := moduleOperationVerdict(result.Code)
	record := moduleOperationRecord{
		OperationId: id, Command: operation.Command, Args: operation.Args,
		Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr, OutputFiles: result.OutputFiles,
		Commit: commit, CommitAfter: commitAfter, CleanBefore: cleanBefore, CleanAfter: cleanAfter,
		VerifiedCommit: verifiedCommit, Sandboxed: operation.Sandbox == nil || *operation.Sandbox,
		Verdict: verdict, NoVerdictReason: noVerdictReason, TimedOut: result.TimedOut,
		TimeoutMs: timeoutMs, WaitMs: waitMs, ElapsedMs: NowMillis() - started,
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
		Verdict: verdict, NoVerdictReason: noVerdictReason, TimedOut: result.TimedOut,
		TimeoutMs: timeoutMs, WaitMs: waitMs, ElapsedMs: record.ElapsedMs,
	}
	evaluated := moduleOperationEvaluated{
		Ok: true, State: options.State,
		Outputs:     map[string]any{operation.Output: moduleOperationOutputValue(output)},
		Diagnostics: []string{"workspace.command " + id},
	}
	if verificationTarget != nil && cleanAfter && graphAcceptanceShaEqual(commit, commitAfter) && result.Code != nil && !result.TimedOut &&
		graphAcceptanceShaEqual(commit, RevParse(commandWorkspace, "HEAD")) && IsClean(commandWorkspace, nil) &&
		verificationWorkspaceMatches(commandWorkspace, *commit, verificationPaths) {
		evaluated.VerificationCommit = commit
		evaluated.VerificationTarget = verificationTarget
	}
	kernel.Store.Transaction(func(tx *TaskStore) any {
		kernel := kernel.scoped(tx)
		kernel.SettleModuleOperation(id, kernel.Content.Encode(evaluated), recordDigest, NowMillis())
		return nil
	})
	kernel.Store.Event(options.GraphId, "graph.operation.settled", map[string]any{
		"moduleId": options.ModuleId, "operationId": id, "passed": output.Passed,
		"verdict": verdict, "timedOut": result.TimedOut,
		"commit": commit, "verifiedCommit": verifiedCommit, "record": recordPath,
	})
	return ModuleOperationResponse{
		Ok: evaluated.Ok, State: evaluated.State, Outputs: evaluated.Outputs, Diagnostics: evaluated.Diagnostics,
	}
}
