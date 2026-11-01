package graph

import (
	"strings"

	"regexp"
)

// ENVIRONMENT_FAILURE matches failures that are the environment's fault.
// A network-ish pattern only decides when the output is non-empty.
//
// The pattern carries two vocabularies because the daemon produces two: the
// Node wording the TypeScript host wrote, and the Go wording this host
// produces. Go says "connection refused" where Node says "ECONNREFUSED",
// "no such host" where Node says "ENOTFOUND", and "connection reset by
// peer" where Node says "socket hang up" - so a pattern that only knew
// Node's wording never classified a single Go-side network failure, and the
// harness's own automatic retry never ran.
var ENVIRONMENT_FAILURE = regexp.MustCompile(`(?i)aborted pending request|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|SSL_ERROR|ERR_SOCKET|Client network socket disconnected|TLS connection|Connection error|at capacity due to high demand|temporarily unavailable|socket disconnected|529|rate limit|no such host|connection refused|connection reset by peer|broken pipe|i/o timeout|unexpected EOF|Provider answered HTTP (429|5[0-9][0-9])|provider cut the arguments|provider closed the stream before the answer was complete`)

// CAPACITY_FAILURE matches a provider that answered "not now" before doing any
// work. The transport already retried it with the pause the provider asked for,
// so the node-level transient retry must not repeat the whole turn on top of
// that: multiplying a capacity budget by the retry count is how one rate limit
// turns into a burst.
var CAPACITY_FAILURE = regexp.MustCompile(`(?i)Provider answered HTTP (429|503)`)

func IsCapacityFailure(output string) bool {
	return len(strings.TrimSpace(output)) > 0 && CAPACITY_FAILURE.MatchString(output)
}

// DISCONNECT_BEFORE_REPLY matches the Go client's message for a connection
// that ended before the provider started answering. The bare word is matched
// after the transport's `: ` so an ordinary "unexpected EOF" in a tool or a
// script error is not read as a network failure.
var DISCONNECT_BEFORE_REPLY = regexp.MustCompile(`(?i):\s*(EOF|unexpected EOF|connection reset by peer|broken pipe)\b|\btls: (bad record MAC|record overflow|handshake failure|unexpected message|bad certificate|unknown certificate)`)

func IsDisconnectBeforeReply(output string) bool {
	return len(strings.TrimSpace(output)) > 0 && DISCONNECT_BEFORE_REPLY.MatchString(output)
}

func IsEnvironmentFailure(output string) bool {
	trimmed := strings.TrimSpace(output)
	return len(trimmed) > 0 && (ENVIRONMENT_FAILURE.MatchString(trimmed) || DISCONNECT_BEFORE_REPLY.MatchString(trimmed))
}
