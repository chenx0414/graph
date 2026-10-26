package graph

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os/exec"
	"sync"
	"syscall"
	"unicode/utf8"

	"bufio"
)

// restrictedProcessState is the mutable state of one running process.
type restrictedProcessState struct {
	process       *exec.Cmd
	stdin         io.WriteCloser
	channel       net.Conn
	ipcConnection net.Conn
	stderr        *lockedBuffer
	command       RestrictedCommand
	requests      sync.Mutex
	mutex         sync.Mutex
	timedOut      bool
	aborted       bool
	pending       []byte
	bytes         int
}

// killTree reaps the whole process group of the sandbox child.
func (state *restrictedProcessState) killTree() {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	if state.process == nil || state.process.Process == nil {
		return
	}
	pid := state.process.Process.Pid
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		_ = state.process.Process.Kill()
	}
}

// readChannel reads the worker's newline-delimited protocol channel.
func (state *restrictedProcessState) readChannel(reader io.Reader) {
	buffer := make([]byte, 64*1024)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			state.mutex.Lock()
			state.pending = append(state.pending, buffer[:read]...)
			state.bytes += read
			overrun := state.bytes > maxWorkerRequestBytes
			state.mutex.Unlock()
			if overrun {
				_ = state.process.Process.Kill()
				return
			}
			for {
				state.mutex.Lock()
				index := bytes.IndexByte(state.pending, '\n')
				if index < 0 {
					state.mutex.Unlock()
					break
				}
				line := append([]byte{}, state.pending[:index]...)
				state.pending = state.pending[index+1:]
				state.bytes -= len(line) + 1
				state.mutex.Unlock()
				if !state.handleLine(line) {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// handleLine answers one worker message. It reports whether the channel
// reader may continue.
func (state *restrictedProcessState) handleLine(line []byte) bool {
	var parsed any
	if err := json.Unmarshal(line, &parsed); err != nil {
		state.appendStderr("Invalid worker request: " + err.Error() + "\n")
		state.killTree()
		return false
	}
	operation := ""
	if object, ok := parsed.(map[string]any); ok {
		operation, _ = object["operation"].(string)
	}
	if operation == "cancel" {
		if state.command.OnCancel != nil {
			state.command.OnCancel(parsed)
		}
		return true
	}
	if state.command.OnWorkerMessage != nil {
		if failed := callSafely(func() { state.command.OnWorkerMessage(parsed) }); failed != nil {
			state.appendStderr("Worker notification handling failed: " + failed.Error() + "\n")
			state.killTree()
			return false
		}
		return true
	}
	state.requests.Lock()
	defer state.requests.Unlock()
	var reply any
	if state.command.OnRequest == nil {
		reply = workerErrorReply{Ok: false, Error: "Worker requests not enabled"}
	} else {
		value, err := state.command.OnRequest(parsed)
		if err != nil {
			reply = workerErrorReply{Ok: false, Error: err.Error()}
		} else {
			reply = workerOkReply{Ok: true, Value: value}
		}
	}
	if _, err := io.WriteString(state.channel, EncodeWorkerReply(reply, maxWorkerReplyBytes)+"\n"); err != nil {
		return false
	}
	return true
}

// readIpc answers the host's Node IPC channel in local-network mode.
func (state *restrictedProcessState) readIpc(connection net.Conn) {
	reader := bufio.NewReader(connection)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			state.handleIpcLine(line)
		}
		if err != nil {
			return
		}
	}
}

// handleIpcLine answers one loopback-listener request of the check.
func (state *restrictedProcessState) handleIpcLine(line []byte) {
	var request map[string]any
	if err := json.Unmarshal(line, &request); err != nil {
		return
	}
	kind, _ := request["type"].(string)
	switch kind {
	case "graph-check-listener":
		id, ok := request["id"].(float64)
		if !ok {
			return
		}
		// TODO(port): the host binds the requested port, but Node's IPC
		// protocol carries a socket descriptor as a native handle and the Go
		// host cannot mint one. The request is refused instead of handing a
		// descriptor over.
		state.replyIpc(map[string]any{
			"type":    "graph-check-listener-result",
			"id":      int(id),
			"ok":      false,
			"code":    "EPERM",
			"message": "EPERM: the Go host cannot hand a bound listener to the check",
		})
	case "graph-check-listener-close", "graph-check-listener-adopted":
		// The host owns no descriptor for a request it refused.
	}
}

func (state *restrictedProcessState) replyIpc(payload map[string]any) {
	// The IPC connection is closed with the process; a failed write means the
	// check is gone.
	if state.ipcConnection == nil {
		return
	}
	encoded, err := marshalJSON(payload)
	if err != nil {
		return
	}
	_, _ = state.ipcConnection.Write(append([]byte(encoded), '\n'))
}

func (state *restrictedProcessState) appendStderr(text string) {
	if state.stderr == nil {
		return
	}
	state.stderr.Write(text)
}

// lockedBuffer collects one stream of a running process.
type lockedBuffer struct {
	mutex  sync.Mutex
	buffer []byte
	carry  []byte
}

// pump reads one stream and hands its decoded chunks to the host.
func (buffer *lockedBuffer) pump(reader io.Reader, onChunk func(string)) {
	chunk := make([]byte, 64*1024)
	for {
		read, err := reader.Read(chunk)
		if read > 0 {
			buffer.mutex.Lock()
			buffer.buffer = append(buffer.buffer, chunk[:read]...)
			buffer.mutex.Unlock()
			if onChunk != nil {
				buffer.carry = append(buffer.carry, chunk[:read]...)
				boundary := utf8Boundary(buffer.carry)
				text := string(buffer.carry[:boundary])
				buffer.carry = buffer.carry[boundary:]
				if text != "" {
					onChunk(text)
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// String returns everything the stream produced.
func (buffer *lockedBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return string(buffer.buffer)
}

// Write adds text the host produced to the stream.
func (buffer *lockedBuffer) Write(text string) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	buffer.buffer = append(buffer.buffer, text...)
}

// utf8Boundary returns the length of the prefix that ends on a rune boundary,
// so a multibyte character split across two reads is not decoded twice.
func utf8Boundary(data []byte) int {
	end := len(data)
	for end > 0 && !utf8.RuneStart(data[end-1]) {
		end--
	}
	if end == 0 {
		return 0
	}
	rune, size := utf8.DecodeRune(data[end-1:])
	if rune == utf8.RuneError && size == 1 && len(data)-end+1 < utf8.UTFMax {
		return end - 1
	}
	return len(data)
}
