package graph

import (
	"fmt"
	"strconv"
)

func itoa(n int) string {
	return strconv.Itoa(n)
}

func joinComma(values []string) string {
	out := ""
	for i, value := range values {
		if i > 0 {
			out += ", "
		}
		out += value
	}
	return out
}

// portRecover runs one action and returns the error it raised. It is the
// TypeScript try/catch shape: a panic that was not caught becomes an error the
// caller can inspect, and a RuntimeError keeps its code and field.
func portRecover(fn func()) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			switch e := rec.(type) {
			case error:
				err = e
			default:
				err = fmt.Errorf("%v", rec)
			}
		}
	}()
	fn()
	return nil
}
