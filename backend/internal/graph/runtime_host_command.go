package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"sync"
	"time"

	"bufio"
)

const hostCommandHandshake = 60 * time.Second

func hostCommandWorkerPath() string {
	return filepath.Join(ApplicationRoot, "src", "runtime", "host-command-worker.mjs")
}

type CheckEnvironmentInput struct {
	Executable string
	Declared map[string]string
	Host map[string]string
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
	TimedOut bool `json:"timedOut"`
}

type HostCommandInput struct {
	OutputDir *string
	Cwd string
	Executable string
	Args []string
	Env map[string]string
	TimeoutMs *int
	Signal *AbortSignal
	BeforeStart func()
	Quiescence *ProcessQuiescenceReceipt
}

type hostCommandState struct {
	process       *exec.Cmd
	channel       io.ReadWriteCloser
	streams       map[string]*hostOutputStream
	stdout        hostCommandBuffer
	stderr        hostCommandBuffer
	mutex         sync.Mutex
	killTree      func()
	timer         *time.Timer
	handshake     *time.Timer
	abortListener *abortListener
	timedOut      bool
	started       bool
	unstarted     bool
	truncated     bool
	result        HostCommandResult
}

func RunHostCommand(input HostCommandInput) HostCommandResult {
	if input.Signal != nil && input.Signal.Aborted() {
		return HostCommandResult{Code: nil, Stdout: "", Stderr: ""}
	}
	streams := map[string]*hostOutputStream{}
	if input.OutputDir != nil {
		if err := os.MkdirAll(*input.OutputDir, 0o700); err != nil {
			panic(err)
		}
		open := func(name string) *hostOutputStream {
			path := filepath.Join(*input.OutputDir, name+".log")
			file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				panic(err)
			}
			stream := &hostOutputStream{path: path, file: file, hash: sha256.New()}
			streams[name] = stream
			return stream
		}
		open("stdout")
		open("stderr")
		defer func() {
			for _, stream := range streams {
				_ = stream.file.Close()
			}
		}()
	}
	execPath, electron := GraphNodeRuntime(nil)
	process := exec.Command(execPath, hostCommandWorkerPath())
	process.Env = []string{}
	if electron != "" {
		process.Env = []string{"ELECTRON_RUN_AS_NODE=1"}
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		panic(err)
	}
	stderr, err := process.StderrPipe()
	if err != nil {
		panic(err)
	}
	channel, channelFile, err := newNodeIpcChannel(process)
	if err != nil {
		panic(err)
	}
	state := &hostCommandState{process: process, channel: channel, streams: streams}
	state.killTree = func() {
		state.send(map[string]any{"kind": "cancel"})
	}
	if err := process.Start(); err != nil {
		panic(err)
	}
	_ = channelFile.Close()
	var admissionFailure any
	var resultCode *int
	var resultError string
	hasResult := false
	settled := false
	var outputError error
	finish := func(code *int, extraStderr string) {
		if settled {
			return
		}
		settled = true
		state.stopTimers()
		timedOut, unstarted := state.outcome()
		if input.Signal != nil && state.abortListener != nil {
			input.Signal.RemoveEventListener(state.abortListener)
		}
		if outputError != nil {
			panic(outputError)
		}
		if admissionFailure != nil {
			panic(admissionFailure)
		}
		reason := ""
		if timedOut && input.TimeoutMs != nil {
			reason = hostCommandTimeoutMarker(*input.TimeoutMs) + "\n"
		}
		if unstarted {
			reason += "Command supervisor never reported ready within " + itoa(int(hostCommandHandshake/time.Millisecond)) + "ms\n"
		}
		tail := ""
		if state.truncated {
			tail = "Output truncated at " + itoa(maxHostOutputBytes) + " bytes\n"
		}
		finalCode := code
		if timedOut {
			finalCode = nil
		}
		var outputFiles map[string]HostCommandOutputFile
		if len(streams) > 0 {
			outputFiles = map[string]HostCommandOutputFile{}
			for name, stream := range streams {
				outputFiles[name] = HostCommandOutputFile{Path: stream.path, Bytes: stream.bytes, Digest: hex.EncodeToString(stream.hash.Sum(nil))}
			}
		}
		state.result = HostCommandResult{
			Code:        finalCode,
			Stdout:      state.stdout.String(),
			Stderr:      state.stderr.String() + extraStderr + reason + tail,
			OutputFiles: outputFiles,
			TimedOut:    timedOut,
		}
	}
	go func() {
		reader := bufio.NewReader(channel)
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 {
				message := map[string]any{}
				if decodeErr := json.Unmarshal(line, &message); decodeErr == nil {
					kind, _ := message["kind"].(string)
					switch kind {
					case "ready":
						if (input.Signal != nil && input.Signal.Aborted()) || state.timedOutState() {
							state.killTree()
							break
						}
						if input.BeforeStart != nil {
							func() {
								defer func() {
									if recovered := recover(); recovered != nil {
										admissionFailure = recovered
										state.killTree()
									}
								}()
								input.BeforeStart()
							}()
						}
						if admissionFailure == nil {
							state.begin(input.TimeoutMs)
							state.send(map[string]any{"kind": "start"})
						}
					case "result":
						raw, exists := message["code"]
						if exists && (raw == nil || hostCommandNumber(raw)) {
							if raw == nil {
								resultCode = nil
							} else {
								number := int(raw.(float64))
								resultCode = &number
							}
							hasResult = true
							if text, ok := message["error"].(string); ok {
								resultError = text
							}
						}
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
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
	if input.Signal != nil {
		state.abortListener = input.Signal.AddEventListener("abort", func() {
			state.killTree()
		}, true)
	}
	state.handshake = time.AfterFunc(hostCommandHandshake, func() {
		state.mutex.Lock()
		unstarted := !state.started
		if unstarted {
			state.unstarted = true
		}
		state.mutex.Unlock()
		if unstarted {
			state.killTree()
		}
	})
	environment := map[string]string{}
	for name, value := range input.Env {
		environment[name] = value
	}
	prepare := map[string]any{
		"kind":       "prepare",
		"cwd":        input.Cwd,
		"executable": input.Executable,
		"args":       input.Args,
		"env":        environment,
	}
	if input.Quiescence != nil {
		prepare["quiescence"] = map[string]any{"path": input.Quiescence.Path, "nonce": input.Quiescence.Nonce}
	}
	state.send(prepare)
	pumps.Wait()
	waitErr := process.Wait()
	if waitErr != nil {
		var exitError *exec.ExitError
		if !errors.As(waitErr, &exitError) {
			finish(nil, waitErr.Error()+"\n")
		}
	}
	extra := ""
	if hasResult {
		extra = resultError
	} else {
		extra = "Command supervisor exited without a result\n"
	}
	finish(resultCode, extra)
	return state.result
}

func (state *hostCommandState) begin(timeoutMs *int) {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	if state.started {
		return
	}
	state.started = true
	if state.handshake != nil {
		state.handshake.Stop()
	}
	if timeoutMs == nil {
		return
	}
	state.timer = time.AfterFunc(time.Duration(*timeoutMs)*time.Millisecond, func() {
		state.mutex.Lock()
		state.timedOut = true
		state.mutex.Unlock()
		state.killTree()
	})
}

func (state *hostCommandState) timedOutState() bool {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	return state.timedOut
}

func (state *hostCommandState) stopTimers() {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	if state.timer != nil {
		state.timer.Stop()
	}
	if state.handshake != nil {
		state.handshake.Stop()
	}
}

func (state *hostCommandState) outcome() (bool, bool) {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	return state.timedOut, state.unstarted
}
