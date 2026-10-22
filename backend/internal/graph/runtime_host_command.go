package graph

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Run one command as the host would run it: a direct process, no seatbelt.
//
// This exists for the one case where the sandbox makes the proof worthless. A confirmed gate that
// runs a project's own suite has to run the way that suite is run by the project itself; measured
// 2026-09-30 on task 68543fed, the same copy and the same `node --run check` gave 1480/1480 outside
// the sandbox and 224 failed / 49 passed inside it, mostly the suite's own timeouts. A gate that
// fails for reasons unrelated to the work is not evidence of anything.
//
// A supervisor starts the command in its own process group and kills it on timeout, cancellation
// or owner IPC disconnect. The owner bounds the output it keeps. What it does NOT do is decide
// anything - not whether it was allowed to run (that is `graph.command`'s `sandbox` declaration,
// honoured only under full access) and not what the command may see (that is `checkEnvironment`).

// maxHostOutputBytes is how much of one stream is kept: a check that prints more than this is
// flooding, not evidencing.
const maxHostOutputBytes = 32 * 1024 * 1024

// hostCommandWorkerPath is the Node supervisor that runs the command. The worker stays Node
// (RULEBOOK §7); the Go host speaks its IPC channel.
func hostCommandWorkerPath() string {
	return filepath.Join(ApplicationRoot, "src", "runtime", "host-command-worker.mjs")
}

// CheckEnvironmentInput is the input of the environment an unsandboxed check runs with.
type CheckEnvironmentInput struct {
	// Executable is the program the check runs.
	Executable string
	// Declared is what the host declared for checks; it wins over the allowlist.
	Declared map[string]string
	// Host is read for a few names only - never inherited wholesale.
	Host map[string]string
}

// CheckEnvironment builds the environment an unsandboxed check runs with.
//
// Leaving the sandbox lifts containment; it must not hand over the host's own environment. The first
// version of this inherited `process.env`, which gave a check the app's provider credentials
// (`GRAPH_SUBSCRIPTION_*`), the path of the live checkout, and a PATH without the toolchain - and
// every process the check spawned - so the environment is now built from a short allowlist of what a
// toolchain needs, plus whatever the host declared for checks. The allowlist is exactly the
// difference between "runs like the project" and "runs with everything the app has".
func CheckEnvironment(input CheckEnvironmentInput) map[string]string {
	host := input.Host
	if host == nil {
		host = map[string]string{}
	}
	// A GUI-launched app gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that a developer's shell
	// does not have: the toolchain a project's own suite drives - homebrew, /usr/local - lives outside
	// it. Naming those directories is the difference between "runs like the project" and "runs like the
	// app that started it"; measured 2026-09-30, the merge Agent had to prepend /opt/homebrew/bin by
	// hand to run the same suite.
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

// HostCommandOutputFile is one preserved stream of a host command.
type HostCommandOutputFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	Digest string `json:"digest"`
}

// HostCommandResult is what one host command produced.
type HostCommandResult struct {
	Code        *int                             `json:"code"`
	Stdout      string                           `json:"stdout"`
	Stderr      string                           `json:"stderr"`
	OutputFiles map[string]HostCommandOutputFile `json:"outputFiles,omitempty"`
}

// HostCommandInput is one host command.
type HostCommandInput struct {
	// OutputDir is the host-owned operation directory. Full streams survive bounded inline views.
	OutputDir *string
	// Cwd is the working directory of the command.
	Cwd string
	// Executable is the program to run.
	Executable string
	// Args are the arguments of the program.
	Args []string
	// Env is the whole environment for the child. Build it with `CheckEnvironment`.
	Env map[string]string
	// TimeoutMs is how long the command may run. No limit when omitted.
	TimeoutMs *int
	// Signal cancels the command.
	Signal *AbortSignal
	// BeforeStart is the durable dispatch admission, after the supervisor is ready and before the
	// command starts.
	BeforeStart func()
	// Quiescence is written by the supervisor only after the command has closed.
	Quiescence *ProcessQuiescenceReceipt
}

// hostOutputStream is one preserved stream.
type hostOutputStream struct {
	path  string
	file  *os.File
	bytes int64
	hash  hash.Hash
}

// hostCommandState is the mutable state of one host command.
type hostCommandState struct {
	process       *exec.Cmd
	channel       io.ReadWriteCloser
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

// RunHostCommand runs one command under the Node supervisor and returns what it produced.
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
	// The parent's copy of the inherited descriptor is closed: a parent that
	// keeps the child's end open never sees the channel reach its end.
	_ = channelFile.Close()
	var admissionError error
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
		if state.timer != nil {
			state.timer.Stop()
		}
		if input.Signal != nil && state.abortListener != nil {
			input.Signal.RemoveEventListener(state.abortListener)
		}
		if outputError != nil {
			panic(outputError)
		}
		if admissionError != nil {
			panic(admissionError)
		}
		reason := ""
		if state.timedOut && input.TimeoutMs != nil {
			reason = "Process terminated by SIGKILL: it exceeded the " + itoa(*input.TimeoutMs) + "ms timeout\n"
		}
		tail := ""
		if state.truncated {
			tail = "Output truncated at " + itoa(maxHostOutputBytes) + " bytes\n"
		}
		finalCode := code
		if state.timedOut {
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
		}
	}
	// The worker announces that it is ready for the command; the host admits the
	// operation durably and only then starts it.
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
						if (input.Signal != nil && input.Signal.Aborted()) || state.timedOut {
							state.killTree()
							break
						}
						if input.BeforeStart != nil {
							func() {
								defer func() {
									if recovered := recover(); recovered != nil {
										admissionError = errors.New(errorText(recovered))
										state.killTree()
									}
								}()
								input.BeforeStart()
							}()
						}
						if admissionError == nil {
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
	if input.TimeoutMs != nil {
		state.timer = time.AfterFunc(time.Duration(*input.TimeoutMs)*time.Millisecond, func() {
			state.mutex.Lock()
			state.timedOut = true
			state.mutex.Unlock()
			state.killTree()
		})
	}
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
	waitErr := process.Wait()
	pumps.Wait()
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

// send writes one message to the supervisor.
func (state *hostCommandState) send(message map[string]any) {
	if state.channel == nil {
		return
	}
	encoded, err := marshalJSON(message)
	if err != nil {
		return
	}
	_, _ = state.channel.Write(append([]byte(encoded), '\n'))
}

// readStream keeps one stream of the supervisor and preserves it.
func (state *hostCommandState) readStream(reader io.Reader, name string) {
	buffer := make([]byte, 64*1024)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			state.preserve(name, chunk)
			if name == "stdout" {
				state.stdout.keep(chunk, state)
			} else {
				state.stderr.keep(chunk, state)
			}
		}
		if err != nil {
			return
		}
	}
}

// preserve writes one chunk to the preserved file of a stream.
func (state *hostCommandState) preserve(name string, chunk []byte) {
	stream, ok := state.streams[name]
	if !ok {
		return
	}
	offset := 0
	for offset < len(chunk) {
		written, err := stream.file.Write(chunk[offset:])
		if err != nil {
			state.killTree()
			return
		}
		offset += written
	}
	stream.hash.Write(chunk)
	stream.bytes += int64(len(chunk))
}

// hostCommandBuffer keeps the bounded inline view of one stream.
type hostCommandBuffer struct {
	mutex  sync.Mutex
	chunks [][]byte
	bytes  int
}

// keep adds one chunk to the inline view.
func (buffer *hostCommandBuffer) keep(chunk []byte, state *hostCommandState) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	if buffer.bytes >= maxHostOutputBytes {
		state.truncated = true
		return
	}
	room := len(chunk)
	if remaining := maxHostOutputBytes - buffer.bytes; room > remaining {
		room = remaining
	}
	buffer.chunks = append(buffer.chunks, chunk[:room])
	if room < len(chunk) {
		state.truncated = true
	}
	buffer.bytes += room
}

// String returns the inline view of the stream.
func (buffer *hostCommandBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return string(bytes.Join(buffer.chunks, nil))
}

// hostCommandNumber reports whether a value is a number.
func hostCommandNumber(value any) bool {
	switch value.(type) {
	case float64, int, int64:
		return true
	}
	return false
}

func errorText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return stringifyJSON(rec)
}
