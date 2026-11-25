package graph

import (
	"strings"

	"regexp"
)

var ENVIRONMENT_FAILURE = regexp.MustCompile(`(?i)aborted pending request|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|SSL_ERROR|ERR_SOCKET|Client network socket disconnected|TLS connection|tls: |x509: |certificate signed by unknown authority|certificate has expired|connection not verified|Connection error|at capacity due to high demand|temporarily unavailable|socket disconnected|529|rate limit|no such host|connection refused|connection reset by peer|broken pipe|i/o timeout|unexpected EOF|Provider answered HTTP (429|5[0-9][0-9])|provider cut the arguments|provider closed the stream before the answer was complete|storage error`)

var CAPACITY_FAILURE = regexp.MustCompile(`(?i)Provider answered HTTP (429|503)`)

func IsCapacityFailure(output string) bool {
	return len(strings.TrimSpace(output)) > 0 && CAPACITY_FAILURE.MatchString(output)
}

var DISCONNECT_BEFORE_REPLY = regexp.MustCompile(`(?i):\s*(EOF|unexpected EOF|connection reset by peer|broken pipe)\b|\btls: (bad record MAC|record overflow|handshake failure|unexpected message|bad certificate|unknown certificate)`)

func IsDisconnectBeforeReply(output string) bool {
	return len(strings.TrimSpace(output)) > 0 && DISCONNECT_BEFORE_REPLY.MatchString(output)
}

var MACHINE_EXHAUSTION = regexp.MustCompile(`(?i)no space left on device|ENOSPC|disk quota exceeded`)

func MachineExhaustionReason(output string) string {
	if MACHINE_EXHAUSTION.MatchString(output) {
		return "机器资源耗尽（磁盘已满：no space left on device）"
	}
	return ""
}

func IsEnvironmentFailure(output string) bool {
	trimmed := strings.TrimSpace(output)
	return len(trimmed) > 0 && (ENVIRONMENT_FAILURE.MatchString(trimmed) || DISCONNECT_BEFORE_REPLY.MatchString(trimmed))
}
