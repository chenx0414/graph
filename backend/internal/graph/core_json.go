package graph

// The JSON values the daemon passes around, and the conversions between
// them and the numbers JavaScript would accept.
//
// The graph was written in TypeScript first, so these follow the
// JavaScript rules rather than Go's: a number is a float64 unless it is a
// whole number, and only the whole numbers below the safe limit survive
// a round trip.
import (
	"encoding/json"
	"math"
	"strconv"
	"unicode/utf16"
)

// Json is the TypeScript Json union: nil, bool, float64, string, []any, or map[string]any.

type Json = any

const maxSafeInteger = 9007199254740991

func isSafeInteger(value any) bool {
	f, ok := asFloat(value)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return false
	}
	return f >= -maxSafeInteger && f <= maxSafeInteger
}

func isJSInteger(value any) bool {
	f, ok := asFloat(value)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return false
	}
	return f == math.Trunc(f)
}

func asFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case int32:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func asInt(value any) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			f, ferr := v.Float64()
			if ferr != nil {
				return 0
			}
			return int64(f)
		}
		return i
	default:
		return 0
	}
}

func jsonRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok && record != nil
}

func jsonClone(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}

func jsonStringify(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func utf16Slice(value string, n int) string {
	units := utf16.Encode([]rune(value))
	if n > len(units) {
		n = len(units)
	}
	if n < 0 {
		n = 0
	}
	return string(utf16.Decode(units[:n]))
}

func enUS(n int) string {
	negative := n < 0
	if negative {
		n = -n
	}
	digits := strconv.Itoa(n)
	out := make([]byte, 0, len(digits)+len(digits)/3)
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, digits[i])
	}
	if negative {
		return "-" + string(out)
	}
	return string(out)
}
