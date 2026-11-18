package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"sync"
	"time"
)

type CheckEnvironmentInput struct {
	Executable string
	Declared   map[string]string
	Host       map[string]string
}

func CheckEnvironment(input CheckEnvironmentInput) map[string]string {
	host := input.Host
	if host == nil {
		host = map[string]string{}
	}
	directories := []string{filepath.Dir(input.Executable)}
	directories = append(directories, splitPath(host["PATH"])...)
	directories = append(directories, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")
	seen := map[string]bool{}
	path := []string{}
	for _, directory := range directories {
		if directory == "" || seen[directory] {
			continue
		}
		seen[directory] = true
		path = append(path, directory)
	}
	environment := map[string]string{
		"PATH":                strings.Join(path, ":"),
		"LANG":                "en_US.UTF-8",
		"GIT_OPTIONAL_LOCKS":  "0",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_ATTR_NOSYSTEM":   "1",
	}
	if value, ok := host["HOME"]; ok {
		environment["HOME"] = value
	} else {
		environment["HOME"] = homeDirectory()
	}
	if host["TMPDIR"] != "" {
		environment["TMPDIR"] = host["TMPDIR"]
	}
	if host["LANG"] != "" {
		environment["LANG"] = host["LANG"]
	}
	if host["LC_ALL"] != "" {
		environment["LC_ALL"] = host["LC_ALL"]
	}
	for name, value := range input.Declared {
		environment[name] = value
	}
	return environment
}

type HostCommandOutputFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	Digest string `json:"digest"`
}

type HostCommandResult struct {
	Code        *int                             `json:"code"`
	Stdout      string                           `json:"stdout"`
	Stderr      string                           `json:"stderr"`
	OutputFiles map[string]HostCommandOutputFile `json:"outputFiles,omitempty"`
	TimedOut    bool                             `json:"timedOut"`
}

type HostCommandInput struct {
	OutputDir   *string
	Cwd         string
	Executable  string
	Args        []string
	Env         map[string]string
	TimeoutMs   *int
	Signal      *AbortSignal
	BeforeStart func()
	Quiescence  *ProcessQuiescenceReceipt
}

type hostCommandState struct {
	streams       map[string]*hostOutputStream
	stdout        hostCommandBuffer
	stderr        hostCommandBuffer
	mutex         sync.Mutex
	killTree      func()
	timer         *time.Timer
	abortListener *abortListener
	timedOut      bool
	truncated     bool
	result        HostCommandResult
}

func openHostOutputStreams(outputDir *string) map[string]*hostOutputStream {
	streams := map[string]*hostOutputStream{}
	if outputDir == nil {
		return streams
	}
	if err := os.MkdirAll(*outputDir, 0o700); err != nil {
		panic(err)
	}
	for _, name := range []string{"stdout", "stderr"} {
		path := filepath.Join(*outputDir, name+".log")
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			panic(err)
		}
		streams[name] = &hostOutputStream{path: path, file: file, hash: sha256.New()}
	}
	return streams
}

func RunHostCommand(input HostCommandInput) HostCommandResult {
	if input.Signal != nil && input.Signal.Aborted() {
		return HostCommandResult{Code: nil, Stdout: "", Stderr: ""}
	}
	streams := openHostOutputStreams(input.OutputDir)
	defer func() {
		for _, stream := range streams {
			_ = stream.file.Close()
		}
	}()
	if input.BeforeStart != nil {
		input.BeforeStart()
	}
	environment := map[string]string{}
	for name, value := range input.Env {
		environment[name] = value
	}
	process := exec.Command(input.Executable, input.Args...)
	process.Dir = input.Cwd
	process.Env = environmentSlice(environment)
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := process.StdoutPipe()
	if err != nil {
		panic(err)
	}
	stderr, err := process.StderrPipe()
	if err != nil {
		panic(err)
	}
	if err := process.Start(); err != nil {
		return HostCommandResult{Code: nil, Stdout: "", Stderr: err.Error() + "\n"}
	}
	pid := process.Process.Pid
	RecordSpawnGroup(pid)
	state := &hostCommandState{streams: streams}
	state.killTree = func() {
		_ = killProcessGroup(process, "KILL")
	}
	var pumps sync.WaitGroup
	pumps.Add(2)
	go func() {
		defer pumps.Done()
		state.readStream(stdout, "stdout")
	}()
	go func() {
		defer pumps.Done()
		state.readStream(stderr, "stderr")
	}()
	if input.TimeoutMs != nil {
		state.timer = time.AfterFunc(time.Duration(*input.TimeoutMs)*time.Millisecond, func() {
			state.mutex.Lock()
			state.timedOut = true
			state.mutex.Unlock()
			state.killTree()
		})
	}
	if input.Signal != nil {
		state.abortListener = input.Signal.AddEventListener("abort", func() {
			state.killTree()
		}, true)
	}
	waitErr := process.Wait()
	state.killTree()
	awaitProcessGroupGone(pid)
	pumps.Wait()
	ForgetSpawnGroup(pid)
	if state.timer != nil {
		state.timer.Stop()
	}
	if input.Signal != nil && state.abortListener != nil {
		input.Signal.RemoveEventListener(state.abortListener)
	}
	writeQuiescenceReceipt(input.Quiescence)
	state.mutex.Lock()
	timedOut := state.timedOut
	truncated := state.truncated
	state.mutex.Unlock()
	code, notes := hostCommandOutcome(process, waitErr, timedOut, input.TimeoutMs)
	reason := ""
	if timedOut && input.TimeoutMs != nil {
		reason = hostCommandTimeoutMarker(*input.TimeoutMs) + "\n"
	}
	tail := ""
	if truncated {
		tail = "Output truncated at " + itoa(maxHostOutputBytes) + " bytes\n"
	}
	var outputFiles map[string]HostCommandOutputFile
	if len(streams) > 0 {
		outputFiles = map[string]HostCommandOutputFile{}
		for name, stream := range streams {
			outputFiles[name] = HostCommandOutputFile{Path: stream.path, Bytes: stream.bytes, Digest: hex.EncodeToString(stream.hash.Sum(nil))}
		}
	}
	state.result = HostCommandResult{
		Code:        code,
		Stdout:      state.stdout.String(),
		Stderr:      state.stderr.String() + notes + reason + tail,
		OutputFiles: outputFiles,
		TimedOut:    timedOut,
	}
	return state.result
}

func hostCommandOutcome(process *exec.Cmd, waitErr error, timedOut bool, timeoutMs *int) (*int, string) {
	if timedOut {
		return nil, ""
	}
	if waitErr != nil {
		exitError, isExit := waitErr.(*exec.ExitError)
		if !isExit {
			return nil, waitErr.Error() + "\n"
		}
		if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return nil, "Process terminated by " + sandboxSignalName(status.Signal()) + "\n"
		}
	}
	if process.ProcessState == nil {
		return nil, "Command exited without a process status\n"
	}
	code := process.ProcessState.ExitCode()
	if code < 0 {
		return nil, ""
	}
	return &code, ""
}

func awaitProcessGroupGone(pid int) {
	if pid <= 1 {
		return
	}
	limit := time.Now().Add(2 * time.Second)
	for time.Now().Before(limit) {
		if err := syscall.Kill(-pid, 0); err != nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

func writeQuiescenceReceipt(receipt *ProcessQuiescenceReceipt) {
	if receipt == nil {
		return
	}
	body, err := marshalJSON(map[string]any{"nonce": receipt.Nonce, "quiescent": true})
	if err != nil {
		return
	}
	file, err := os.OpenFile(receipt.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	_, _ = file.WriteString(body)
}
