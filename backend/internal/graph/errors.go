package graph

import "fmt"

type RuntimeError struct {
	Code    string
	Message string
	Field   string
	Status int
}

func (e *RuntimeError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func Raise(code, message string) {
	panic(&RuntimeError{Code: code, Message: message})
}

func RaiseStatus(status int, code, message string) {
	panic(&RuntimeError{Code: code, Message: message, Status: status})
}

func RaiseField(code, message, field string) {
	panic(&RuntimeError{Code: code, Message: message, Field: field})
}

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
