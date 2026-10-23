package graph

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"syscall"
)

// ControlledIsTerminalSseLine reports whether one SSE line ends the event stream.
func ControlledIsTerminalSseLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return false
	}
	payload := strings.TrimSpace(trimmed[5:])
	if payload == "[DONE]" {
		return true
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return false
	}
	return event["type"] == "message_stop"
}

// controlledTransportCode reads the transport failure one error carries.
func controlledTransportCode(err error) string {
	if err == nil {
		return ""
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return "ENOTFOUND"
	}
	var opError *net.OpError
	if errors.As(err, &opError) {
		if opError.Timeout() {
			return "UND_ERR_CONNECT_TIMEOUT"
		}
		var syscallError *os.SyscallError
		if errors.As(opError.Err, &syscallError) && syscallError.Err == syscall.ECONNREFUSED {
			return "ECONNREFUSED"
		}
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		return "UND_ERR_CONNECT_TIMEOUT"
	}
	return ""
}

// controlledReleaseBody is a response body that gives the concurrency slot back when it closes.
type controlledReleaseBody struct {
	io.ReadCloser
	release func()
	once    bool
}

// Close closes the body and releases the slot.
func (body *controlledReleaseBody) Close() error {
	if !body.once {
		body.once = true
		if body.release != nil {
			body.release()
		}
	}
	return body.ReadCloser.Close()
}
