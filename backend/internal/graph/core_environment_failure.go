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
var ENVIRONMENT_FAILURE = regexp.MustCompile(`(?i)aborted pending request|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|SSL_ERROR|ERR_SOCKET|Client network socket disconnected|TLS connection|Connection error|at capacity due to high demand|temporarily unavailable|socket disconnected|529|rate limit|no such host|connection refused|connection reset by peer|broken pipe|i/o timeout|unexpected EOF|Provider answered HTTP (429|5[0-9][0-9])`)

func IsEnvironmentFailure(output string) bool {
	return len(strings.TrimSpace(output)) > 0 && ENVIRONMENT_FAILURE.MatchString(output)
}
