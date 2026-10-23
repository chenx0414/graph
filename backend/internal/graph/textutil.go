package graph

import (
	"fmt"
	"strconv"
)

func itoa(n int) string {
	return strconv.Itoa(n)
}

// lessByByteOrder orders names by UTF-8 byte value. The TypeScript port sorted
// these names with localeCompare; byte order is the deliberate stand-in, so
// every order a reader sees calls this instead of a bare <.
func lessByByteOrder(left, right string) bool {
	return left < right
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
