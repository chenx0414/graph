package graph

import (
	"regexp"
	"strings"
)

// ENVIRONMENT_FAILURE matches failures that are the environment's fault.
// A network-ish pattern only decides when the output is non-empty.
var ENVIRONMENT_FAILURE = regexp.MustCompile(`(?i)aborted pending request|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|SSL_ERROR|ERR_SOCKET|Client network socket disconnected|TLS connection|Connection error|at capacity due to high demand|temporarily unavailable|socket disconnected|529|rate limit`)

func IsEnvironmentFailure(output string) bool {
	return len(strings.TrimSpace(output)) > 0 && ENVIRONMENT_FAILURE.MatchString(output)
}
