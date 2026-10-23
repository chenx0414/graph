package graph

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// spawnAndWait starts one restricted process and waits for its result.
func (executor *sandboxExecutor) spawnAndWait(command RestrictedCommand, launched string, launchedArgs []string, cwd string, environment map[string]string, localNetwork bool) CommandResult {
	process := exec.Command(launched, launchedArgs...)
	process.Dir = cwd
	process.Env = environmentSlice(environment)
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := process.StdinPipe()
	if err != nil {
		panic(err)
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		panic(err)
	}
	stderr, err := process.StderrPipe()
	if err != nil {
		panic(err)
	}
	// The worker channel is duplex: the child writes its notifications on it
	// and the host answers on the same channel.
	channel, channelFile, err := newDuplexChannel(process)
	if err != nil {
		panic(err)
	}
	var ipc net.Conn
	var ipcFile *os.File
	if localNetwork {
		connection, file, err := newNodeIpcChannel(process)
		if err != nil {
			panic(err)
		}
		ipc = connection
		ipcFile = file
	}
	if err := process.Start(); err != nil {
		panic(err)
	}
	// The parent's copies of the inherited descriptors are closed: a parent
	// that keeps the child's end open never sees the channel reach its end.
	_ = channelFile.Close()
	if ipcFile != nil {
		_ = ipcFile.Close()
	}
	pid := process.Process.Pid
	// The host writes the child's request on stdin, and the host may steer the
	// same stream afterwards. One lock keeps those writes from interleaving.
	var stdinMutex sync.Mutex
	writeStdin := func(payload string) bool {
		stdinMutex.Lock()
		defer stdinMutex.Unlock()
		_, err := io.WriteString(stdin, payload)
		return err == nil
	}
	control := RestrictedProcessControl{
		Pid: &pid,
		Write: func(message any) bool {
			encoded, err := marshalJSON(message)
			if err != nil {
				return false
			}
			return writeStdin(encoded + "\n")
		},
		End: func() {
			stdinMutex.Lock()
			defer stdinMutex.Unlock()
			_ = stdin.Close()
		},
		Kill: func(signal string) bool {
			return killProcessGroup(process, signal)
		},
	}
	if command.OnSpawn != nil {
		command.OnSpawn(McpProcessControl{Kill: control.Kill, End: control.End})
	}
	if command.OnProcess != nil {
		command.OnProcess(control)
	}
	var stdoutBuffer, stderrBuffer lockedBuffer
	state := &restrictedProcessState{
		process:       process,
		stdin:         stdin,
		channel:       channel,
		ipcConnection: ipc,
		stderr:        &stderrBuffer,
		command:       command,
	}
	var listener *abortListener
	if command.Signal != nil {
		listener = command.Signal.AddEventListener("abort", func() {
			state.aborted = true
			state.killTree()
		}, true)
	}
	var timer *time.Timer
	if command.TimeoutMs > 0 {
		timer = time.AfterFunc(time.Duration(command.TimeoutMs)*time.Millisecond, func() {
			state.timedOut = true
			state.killTree()
		})
	}
	var pumps sync.WaitGroup
	pumps.Add(3)
	go func() { defer pumps.Done(); stdoutBuffer.pump(stdout, command.OnStdout) }()
	go func() { defer pumps.Done(); stderrBuffer.pump(stderr, nil) }()
	go func() { defer pumps.Done(); state.readChannel(channel) }()
	if ipc != nil {
		pumps.Add(1)
		go func() { defer pumps.Done(); state.readIpc(ipc) }()
	}
	// The child reads its request from stdin. A kept-open stdin lets the host
	// steer a long-running worker, so the request is written and the stream
	// stays open; every other command ends the stream so the child sees EOF.
	// The write runs on its own goroutine: a child that never reads its stdin
	// must not block the host before the timeout reaps it.
	go func() {
		if command.Input != "" && !writeStdin(command.Input) {
			return
		}
		if !command.KeepStdinOpen {
			control.End()
		}
	}()
	waitErr := process.Wait()
	pumps.Wait()
	if timer != nil {
		timer.Stop()
	}
	if listener != nil && command.Signal != nil {
		command.Signal.RemoveEventListener(listener)
	}
	state.killTree()
	if state.aborted {
		panic(errors.New("Command aborted by user"))
	}
	result := CommandResult{
		Stdout: stdoutBuffer.String(),
		Stderr: stderrBuffer.String(),
	}
	if waitErr != nil {
		var exitError *exec.ExitError
		if errors.As(waitErr, &exitError) {
			if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				name := sandboxSignalName(status.Signal())
				if state.timedOut {
					result.Stderr += fmt.Sprintf("Process terminated by %s: it exceeded the %dms timeout\n", name, command.TimeoutMs)
				} else {
					result.Stderr += fmt.Sprintf("Process terminated by %s\n", name)
				}
			}
		} else {
			result.Stderr += waitErr.Error() + "\n"
		}
	}
	if code := process.ProcessState.ExitCode(); code >= 0 {
		value := code
		result.Code = &value
	}
	return result
}
