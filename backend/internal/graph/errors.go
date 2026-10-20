package graph

import "fmt"

// RuntimeError is the TypeScript RuntimeError. Handlers recover it at the
// HTTP and CLI boundary. Domain code raises it with Raise, matching throw.
type RuntimeError struct {
	Code    string
	Message string
	Field   string
	// Status is the HTTP status when the TypeScript error carried statusCode.
	// Zero means 400 for a RuntimeError, which is what the Fastify handler did.
	Status int
}

func (e *RuntimeError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Raise panics with a RuntimeError. Use it where TypeScript threw RuntimeError.
func Raise(code, message string) {
	panic(&RuntimeError{Code: code, Message: message})
}

// RaiseStatus panics with an error that already has an HTTP status.
// Authentication and origin checks in the TypeScript server did this.
func RaiseStatus(status int, code, message string) {
	panic(&RuntimeError{Code: code, Message: message, Status: status})
}

// RaiseField panics with a config error that names the offending field.
func RaiseField(code, message, field string) {
	panic(&RuntimeError{Code: code, Message: message, Field: field})
}

// PublicError maps a recovered panic to the HTTP body the Fastify error
// handler sent: RuntimeError is 400 unless it carries a status; anything else
// is 500 internal.
func PublicError(recovered any) (status int, code, message, field string) {
	switch err := recovered.(type) {
	case *RuntimeError:
		status = err.Status
		if status == 0 {
			status = 400
		}
		code = err.Code
		if code == "" {
			code = "internal"
		}
		return status, code, err.Message, err.Field
	case RuntimeError:
		status = err.Status
		if status == 0 {
			status = 400
		}
		code = err.Code
		if code == "" {
			code = "internal"
		}
		return status, code, err.Message, err.Field
	case error:
		return 500, "internal", err.Error(), ""
	default:
		return 500, "internal", fmt.Sprint(recovered), ""
	}
}
