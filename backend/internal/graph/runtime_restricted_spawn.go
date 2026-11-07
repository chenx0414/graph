package graph

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

func openPreservedStream(directory, name string) *os.File {
	if directory == "" {
		return nil
	}
	file, err := os.OpenFile(filepath.Join(directory, name+".log"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		panic(err)
	}
	return file
}

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
	_ = channelFile.Close()
	if ipcFile != nil {
		_ = ipcFile.Close()
	}
	pid := process.Process.Pid
	execDebugTimeline("launched pid=%d timeoutMs=%d", pid, command.TimeoutMs)
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
			execDebugTimeline("timer fired pid=%d", pid)
			state.killTree()
		})
	}
	stdoutLog := openPreservedStream(command.ScratchDir, "stdout")
	stderrLog := openPreservedStream(command.ScratchDir, "stderr")
	defer func() {
		if stdoutLog != nil {
			_ = stdoutLog.Close()
		}
		if stderrLog != nil {
			_ = stderrLog.Close()
		}
	}()
	var pumps sync.WaitGroup
	pumps.Add(3)
	go func() {
		defer pumps.Done()
		stdoutBuffer.pump(preservedStream{reader: stdout, file: stdoutLog}, command.OnStdout)
	}()
	go func() { defer pumps.Done(); stderrBuffer.pump(preservedStream{reader: stderr, file: stderrLog}, nil) }()
	go func() { defer pumps.Done(); state.readChannel(channel) }()
	if ipc != nil {
		pumps.Add(1)
		go func() { defer pumps.Done(); state.readIpc(ipc) }()
	}
	go func() {
		if command.Input != "" && !writeStdin(command.Input) {
			return
		}
		if !command.KeepStdinOpen {
			control.End()
		}
	}()
	waitErr := process.Wait()
	execDebugTimeline("wait returned err=%v", waitErr)
	execDebugTimeline("pumps waiting")
	pumps.Wait()
	execDebugTimeline("pumps drained")
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
	notes := ""
	if waitErr != nil {
		var exitError *exec.ExitError
		if errors.As(waitErr, &exitError) {
			if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				if state.timedOut {
					notes = hostCommandTimeoutMarker(command.TimeoutMs) + "\n"
				} else {
					notes = fmt.Sprintf("Process terminated by %s\n", sandboxSignalName(status.Signal()))
				}
			}
		} else {
			notes = waitErr.Error() + "\n"
		}
	}
	result := CommandResult{
		Stdout: stdoutBuffer.String(),
		Stderr: stderrBuffer.String() + notes,
	}
	if code := process.ProcessState.ExitCode(); code >= 0 {
		value := code
		result.Code = &value
	}
	return result
}
