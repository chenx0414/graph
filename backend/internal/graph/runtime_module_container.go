package graph

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"context"
)

// MODULE_IMAGE is the pinned runtime, prepared by the operator. Evaluations never pull an image or use the network.
const MODULE_IMAGE = "node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"

// MODULE_MEMORY_MB is the default resident memory a module process may use.
const MODULE_MEMORY_MB = 256

// moduleDockerTimeout bounds every helper docker call.
const moduleDockerTimeout = 5 * time.Second

// moduleDockerOutputLimit is how much helper output is kept for diagnostics.
const moduleDockerOutputLimit = 4096

// ModuleContainerInput is one module evaluation request.
type ModuleContainerInput struct {
	Directory      string
	Payload        string
	MemoryMb       int
	TimeoutMs      int
	MaxOutputBytes int
}

// ModuleContainerResult is the container's exit code and captured output.
type ModuleContainerResult struct {
	Code   *int   `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

// moduleDocker runs one docker helper command and reports its answer.
func moduleDocker(args []string) ModuleContainerResult {
	ctx, cancel := context.WithTimeout(context.Background(), moduleDockerTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "docker", args...)
	stdout := &moduleCapture{limit: moduleDockerOutputLimit}
	stderr := &moduleCapture{limit: moduleDockerOutputLimit}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	result := ModuleContainerResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if err != nil {
		if ctx.Err() != nil {
			// The helper was killed before it answered: the code is unknown, not zero.
			return result
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code := exit.ExitCode()
			result.Code = &code
			return result
		}
		result.Stderr = err.Error()
		return result
	}
	code := 0
	result.Code = &code
	return result
}

// moduleCapture keeps the first bounded slice of one output stream.
type moduleCapture struct {
	mu     sync.Mutex
	buffer strings.Builder
	limit  int
	budget *moduleOutputLimit
}

func (capture *moduleCapture) Write(chunk []byte) (int, error) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.budget != nil && capture.budget.exceeded() != "" {
		return len(chunk), nil
	}
	if utf8.RuneCountInString(capture.buffer.String()) < capture.limit {
		capture.buffer.Write(chunk)
	}
	return len(chunk), nil
}

func (capture *moduleCapture) String() string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.buffer.String()
}

// moduleOutputLimit counts the combined stdout and stderr of one module run.
type moduleOutputLimit struct {
	mu      sync.Mutex
	total   int
	limit   int
	message string
	trigger func()
}

// record adds one chunk and fires the trigger once the output budget is gone.
func (limit *moduleOutputLimit) record(chunk []byte) {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	limit.total += len(chunk)
	if limit.message != "" {
		return
	}
	if limit.total > limit.limit {
		limit.message = fmt.Sprintf("module output exceeded %d bytes", limit.limit)
		if limit.trigger != nil {
			limit.trigger()
		}
	}
}

// exceeded reports the limit message once the budget is gone.
func (limit *moduleOutputLimit) exceeded() string {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	return limit.message
}

// RunModuleContainer runs one module inside the pinned container and reports what it said.
func RunModuleContainer(input ModuleContainerInput) ModuleContainerResult {
	if !jsSafeInteger(input.MemoryMb) || input.MemoryMb < 64 || input.MemoryMb > 16384 {
		panic(errors.New("Module process memory limit must be between 64 and 16384 MiB"))
	}
	name := "graph-module-" + graphUUID()
	defer moduleDocker([]string{"rm", "--force", name})
	var limitMu sync.Mutex
	limitMessage := ""
	setLimit := func(message string) {
		limitMu.Lock()
		defer limitMu.Unlock()
		if limitMessage == "" {
			limitMessage = message
		}
	}
	currentLimit := func() string {
		limitMu.Lock()
		defer limitMu.Unlock()
		return limitMessage
	}
	var killMu sync.Mutex
	killWait := make(chan struct{})
	killStarted := false
	terminate := func() {
		killMu.Lock()
		defer killMu.Unlock()
		if killStarted {
			return
		}
		killStarted = true
		go func() {
			defer close(killWait)
			moduleDocker([]string{"kill", name})
		}()
	}
	args := []string{
		"run", "--name", name, "--pull=never", "--interactive", "--network=none",
		fmt.Sprintf("--memory=%dm", input.MemoryMb), fmt.Sprintf("--memory-swap=%dm", input.MemoryMb),
		"--pids-limit=32", "--cpus=1", "--cap-drop=ALL", "--security-opt=no-new-privileges",
		"--read-only", "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
		"--mount", "type=bind,src=" + input.Directory + ",dst=/graph,readonly",
		MODULE_IMAGE, "node", "--permission", "--allow-fs-read=/graph/worker.mjs",
		"--allow-fs-read=/graph/module.mjs", "/graph/worker.mjs", "/graph/module.mjs",
	}
	command := exec.Command("docker", args...)
	stdin, err := command.StdinPipe()
	if err != nil {
		panic(err)
	}
	budget := &moduleOutputLimit{limit: input.MaxOutputBytes}
	stdout := &moduleCapture{limit: input.MaxOutputBytes, budget: budget}
	stderr := &moduleCapture{limit: input.MaxOutputBytes, budget: budget}
	command.Stdout = stdout
	command.Stderr = stderr
	budget.trigger = func() {
		setLimit(budget.exceeded())
		terminate()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	}
	if err := command.Start(); err != nil {
		return ModuleContainerResult{Stderr: err.Error()}
	}
	timer := time.AfterFunc(time.Duration(input.TimeoutMs)*time.Millisecond, func() {
		setLimit(fmt.Sprintf("module exceeded %dms timeout", input.TimeoutMs))
		terminate()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	})
	go func() {
		_, _ = stdin.Write([]byte(input.Payload))
		_ = stdin.Close()
	}()
	waitErr := command.Wait()
	timer.Stop()
	result := ModuleContainerResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if waitErr != nil {
		var exit *exec.ExitError
		if errors.As(waitErr, &exit) {
			code := exit.ExitCode()
			if code >= 0 {
				result.Code = &code
			}
		} else {
			result.Stderr = waitErr.Error()
		}
	} else {
		// A module that answered has an exit code of zero. Leaving the code
		// empty made every successful evaluation look like an unknown exit,
		// and the host reported it as a failed module.
		code := 0
		result.Code = &code
	}
	killMu.Lock()
	started := killStarted
	killMu.Unlock()
	if started {
		<-killWait
	}
	if message := currentLimit(); message != "" {
		result.Stderr = message
	}
	enforcement := moduleDocker([]string{"inspect", "--format", "{{.State.OOMKilled}}", name})
	if strings.TrimSpace(enforcement.Stdout) == "true" {
		oom := 137
		result.Code = &oom
		result.Stderr = fmt.Sprintf("module exceeded the %d MiB process memory limit", input.MemoryMb)
		return result
	}
	return result
}
