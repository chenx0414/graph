package graph

import (
	"strconv"

	"fmt"
)

func itoa(n int) string {
	return strconv.Itoa(n)
}

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
