package graph

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

// ProviderTransportObservation is what one provider attempt looked like from
// the outside.
//
// Correlation evidence only: entering fetch never proves that the provider
// received the request or that it was billed. The observation says what the
// transport saw, nothing more.
type ProviderTransportObservation struct {
	CallID                        string
	At                            int64
	Phase                         string
	RequestSha256                 *string
	ClientRequestID               *string
	Status                        *int
	ResponseIDs                   map[string]string
	ErrorCodes                    []string
	ErrorNames                    []string
	UsageRecoverableFromTransport *bool
}

// Fields is the observation as the event carries it.
//
// The two correlation fields are always present, even when they carry
// nothing: a reader must be able to tell "there was no correlation id" from
// "the field was never written".
func (observation ProviderTransportObservation) Fields() map[string]any {
	fields := map[string]any{
		"callId":          observation.CallID,
		"at":              observation.At,
		"phase":           observation.Phase,
		"requestSha256":   nil,
		"clientRequestId": nil,
	}
	if observation.RequestSha256 != nil {
		fields["requestSha256"] = *observation.RequestSha256
	}
	if observation.ClientRequestID != nil {
		fields["clientRequestId"] = *observation.ClientRequestID
	}
	if observation.Status != nil {
		fields["status"] = *observation.Status
	}
	if observation.ResponseIDs != nil {
		fields["responseIds"] = observation.ResponseIDs
	}
	if len(observation.ErrorCodes) > 0 {
		fields["errorCodes"] = observation.ErrorCodes
	}
	if len(observation.ErrorNames) > 0 {
		fields["errorNames"] = observation.ErrorNames
	}
	if observation.UsageRecoverableFromTransport != nil {
		fields["usageRecoverableFromTransport"] = *observation.UsageRecoverableFromTransport
	}
	return fields
}

// controlledIdentifierPattern accepts the bounded identifiers one observation
// may carry.
var controlledIdentifierPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// controlledRequestSha256 hashes the body one request carries.
func controlledRequestSha256(request *http.Request) *string {
	if request == nil {
		return nil
	}
	body := requestBodyOf(request)
	if body == nil {
		return nil
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	return &digest
}

// controlledResponseRequestIds reads the correlation ids the provider answered
// with.
//
// Only bounded, printable identifiers are kept: a response header may carry
// anything, and this observation is stored next to the task.
func controlledResponseRequestIds(header http.Header) map[string]string {
	ids := map[string]string{}
	for _, name := range []string{"x-opencode-request-id", "x-request-id", "request-id"} {
		value := strings.TrimSpace(header.Get(name))
		if value == "" || len(value) > 256 {
			continue
		}
		printable := true
		for _, character := range value {
			if character < 0x21 || character > 0x7e {
				printable = false
				break
			}
		}
		if printable {
			ids[name] = value
		}
	}
	return ids
}

// controlledRequestIDHeader names the correlation header a gateway forwards.
//
// OpenCode forwards this header; it is not an idempotency key.
func controlledRequestIDHeader(entry ModelEntry) string {
	if entry.Provider == "opencode-go" || strings.Contains(entry.BaseUrl, "opencode.ai/zen/go") {
		return "x-opencode-request-id"
	}
	return ""
}

// controlledTransportErrnoCodes are the bounded identifiers one socket failure
// carries.
var controlledTransportErrnoCodes = []struct {
	errno syscall.Errno
	code  string
}{
	{syscall.ECONNREFUSED, "ECONNREFUSED"},
	{syscall.ECONNRESET, "ECONNRESET"},
	{syscall.ECONNABORTED, "ECONNABORTED"},
	{syscall.EPIPE, "EPIPE"},
	{syscall.ETIMEDOUT, "ETIMEDOUT"},
	{syscall.EHOSTUNREACH, "EHOSTUNREACH"},
	{syscall.ENETUNREACH, "ENETUNREACH"},
}

// controlledTransportSentinelCodes name the failures that are not a syscall
// but still say something about the attempt.
var controlledTransportSentinelCodes = []struct {
	failure error
	code    string
}{
	{io.ErrUnexpectedEOF, "UNEXPECTED_EOF"},
	{io.EOF, "EOF"},
	{context.Canceled, "CANCELED"},
	{context.DeadlineExceeded, "DEADLINE_EXCEEDED"},
}

// controlledTransportErrorCodes names a transport failure without carrying its
// message.
//
// A message or a URL can contain credentials, so only identifiers are kept:
// never headers, request content or an arbitrary error serialization.
func controlledTransportErrorCodes(err error) []string {
	if err == nil {
		return nil
	}
	codes := map[string]bool{}
	current := err
	for depth := 0; depth < 6 && current != nil; depth++ {
		if code := controlledTransportCode(current); code != "" {
			codes[code] = true
		}
		for _, known := range controlledTransportErrnoCodes {
			if errors.Is(current, known.errno) {
				codes[known.code] = true
			}
		}
		for _, known := range controlledTransportSentinelCodes {
			if errors.Is(current, known.failure) {
				codes[known.code] = true
			}
		}
		current = errors.Unwrap(current)
	}
	return controlledSortedIdentifiers(codes)
}

// controlledTransportErrorNames names the kinds of failure one transport
// failure went through.
//
// The name is the kind of the error, never its text: the text may name a URL.
func controlledTransportErrorNames(err error) []string {
	if err == nil {
		return nil
	}
	names := map[string]bool{}
	current := err
	for depth := 0; depth < 6 && current != nil; depth++ {
		if name := controlledErrorKind(current); name != "" {
			names[name] = true
		}
		for _, known := range controlledTransportSentinelCodes {
			if errors.Is(current, known.failure) {
				names[known.code] = true
			}
		}
		current = errors.Unwrap(current)
	}
	return controlledSortedIdentifiers(names)
}

// controlledErrorKind reads the kind of one error.
func controlledErrorKind(err error) string {
	kind := reflect.TypeOf(err)
	if kind == nil {
		return ""
	}
	for kind.Kind() == reflect.Pointer {
		kind = kind.Elem()
	}
	name := kind.Name()
	if !controlledIdentifierPattern.MatchString(name) {
		return ""
	}
	return name
}

// controlledSortedIdentifiers lists the identifiers one failure carried.
func controlledSortedIdentifiers(values map[string]bool) []string {
	out := make([]string, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
