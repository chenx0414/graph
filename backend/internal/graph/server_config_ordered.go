package graph

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"bytes"
)

func orderedInteger(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, ".eE") {
		return false
	}
	_, err := strconv.ParseInt(raw, 10, 64)
	return err == nil
}

type orderedField struct {
	key   string
	value *orderedJSON
}

type orderedJSON struct {
	kind byte
	b    bool
	num  string
	str  string
	arr  []*orderedJSON
	obj  []orderedField
}

func (value *orderedJSON) clone() *orderedJSON {
	if value == nil {
		return nil
	}
	out := *value
	if value.arr != nil {
		out.arr = make([]*orderedJSON, len(value.arr))
		for i, item := range value.arr {
			out.arr[i] = item.clone()
		}
	}
	if value.obj != nil {
		out.obj = make([]orderedField, len(value.obj))
		for i, field := range value.obj {
			out.obj[i] = orderedField{key: field.key, value: field.value.clone()}
		}
	}
	return &out
}

func (value *orderedJSON) get(key string) (*orderedJSON, bool) {
	for _, field := range value.obj {
		if field.key == key {
			return field.value, true
		}
	}
	return nil, false
}

func (value *orderedJSON) set(key string, next *orderedJSON) {
	for i := range value.obj {
		if value.obj[i].key == key {
			value.obj[i].value = next
			return
		}
	}
	value.obj = append(value.obj, orderedField{key: key, value: next})
}

func (value *orderedJSON) any() any {
	switch value.kind {
	case 'n':
		return nil
	case 'b':
		return value.b
	case 'f':
		number, err := strconv.ParseFloat(value.num, 64)
		if err != nil {
			panic(err)
		}
		return number
	case 's':
		return value.str
	case 'a':
		out := make([]any, len(value.arr))
		for i, item := range value.arr {
			out[i] = item.any()
		}
		return out
	default:
		out := map[string]any{}
		for _, field := range value.obj {
			out[field.key] = field.value.any()
		}
		return out
	}
}

func orderedFromAny(record map[string]any) *orderedJSON {
	encoded, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	value, err := parseOrderedJSON(string(encoded))
	if err != nil {
		panic(err)
	}
	return value
}

func (value *orderedJSON) pretty(indent int) string {
	pad := strings.Repeat(" ", indent)
	inner := strings.Repeat(" ", indent+2)
	switch value.kind {
	case 'n':
		return "null"
	case 'b':
		if value.b {
			return "true"
		}
		return "false"
	case 'f':
		return value.num
	case 's':
		return orderedString(value.str)
	case 'a':
		if len(value.arr) == 0 {
			return "[]"
		}
		var buf strings.Builder
		buf.WriteString("[\n")
		for i, item := range value.arr {
			buf.WriteString(inner)
			buf.WriteString(item.pretty(indent + 2))
			if i+1 != len(value.arr) {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteByte(']')
		return buf.String()
	default:
		if len(value.obj) == 0 {
			return "{}"
		}
		var buf strings.Builder
		buf.WriteString("{\n")
		for i, field := range value.obj {
			buf.WriteString(inner)
			buf.WriteString(orderedString(field.key))
			buf.WriteString(": ")
			buf.WriteString(field.value.pretty(indent + 2))
			if i+1 != len(value.obj) {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteByte('}')
		return buf.String()
	}
}

func orderedString(value string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimRight(buf.String(), "\n")
}

type orderedParser struct {
	text string
	i    int
}

func parseOrderedJSON(text string) (*orderedJSON, error) {
	parser := &orderedParser{text: text}
	parser.skip()
	value, err := parser.value()
	if err != nil {
		return nil, err
	}
	parser.skip()
	if parser.i != len(parser.text) {
		return nil, errors.New("trailing json")
	}
	return value, nil
}

func (parser *orderedParser) skip() {
	for parser.i < len(parser.text) {
		c := parser.text[parser.i]
		if c == ' ' || c == '\n' || c == '\r' || c == '\t' {
			parser.i++
			continue
		}
		break
	}
}

func (parser *orderedParser) value() (*orderedJSON, error) {
	parser.skip()
	if parser.i >= len(parser.text) {
		return nil, errors.New("unexpected end of json")
	}
	switch parser.text[parser.i] {
	case 'n':
		if !strings.HasPrefix(parser.text[parser.i:], "null") {
			return nil, errors.New("invalid json")
		}
		parser.i += 4
		return &orderedJSON{kind: 'n'}, nil
	case 't':
		if !strings.HasPrefix(parser.text[parser.i:], "true") {
			return nil, errors.New("invalid json")
		}
		parser.i += 4
		return &orderedJSON{kind: 'b', b: true}, nil
	case 'f':
		if !strings.HasPrefix(parser.text[parser.i:], "false") {
			return nil, errors.New("invalid json")
		}
		parser.i += 5
		return &orderedJSON{kind: 'b'}, nil
	case '"':
		text, err := parser.string()
		if err != nil {
			return nil, err
		}
		return &orderedJSON{kind: 's', str: text}, nil
	case '[':
		parser.i++
		var items []*orderedJSON
		parser.skip()
		if parser.i < len(parser.text) && parser.text[parser.i] == ']' {
			parser.i++
			return &orderedJSON{kind: 'a', arr: items}, nil
		}
		for {
			item, err := parser.value()
			if err != nil {
				return nil, err
			}
			items = append(items, item)
			parser.skip()
			if parser.i >= len(parser.text) {
				return nil, errors.New("unterminated array")
			}
			if parser.text[parser.i] == ']' {
				parser.i++
				break
			}
			if parser.text[parser.i] != ',' {
				return nil, errors.New("expected comma")
			}
			parser.i++
		}
		return &orderedJSON{kind: 'a', arr: items}, nil
	case '{':
		parser.i++
		var fields []orderedField
		parser.skip()
		if parser.i < len(parser.text) && parser.text[parser.i] == '}' {
			parser.i++
			return &orderedJSON{kind: 'o', obj: fields}, nil
		}
		for {
			parser.skip()
			if parser.i >= len(parser.text) || parser.text[parser.i] != '"' {
				return nil, errors.New("expected key")
			}
			key, err := parser.string()
			if err != nil {
				return nil, err
			}
			parser.skip()
			if parser.i >= len(parser.text) || parser.text[parser.i] != ':' {
				return nil, errors.New("expected colon")
			}
			parser.i++
			item, err := parser.value()
			if err != nil {
				return nil, err
			}
			fields = append(fields, orderedField{key: key, value: item})
			parser.skip()
			if parser.i >= len(parser.text) {
				return nil, errors.New("unterminated object")
			}
			if parser.text[parser.i] == '}' {
				parser.i++
				break
			}
			if parser.text[parser.i] != ',' {
				return nil, errors.New("expected comma")
			}
			parser.i++
		}
		return &orderedJSON{kind: 'o', obj: fields}, nil
	default:
		start := parser.i
		for parser.i < len(parser.text) {
			c := parser.text[parser.i]
			if c == ',' || c == ']' || c == '}' || c == ' ' || c == '\n' || c == '\r' || c == '\t' {
				break
			}
			parser.i++
		}
		if start == parser.i {
			return nil, errors.New("invalid json")
		}
		return &orderedJSON{kind: 'f', num: parser.text[start:parser.i]}, nil
	}
}

func (parser *orderedParser) string() (string, error) {
	if parser.text[parser.i] != '"' {
		return "", errors.New("expected string")
	}
	parser.i++
	var buf strings.Builder
	for parser.i < len(parser.text) {
		c := parser.text[parser.i]
		if c == '"' {
			parser.i++
			return buf.String(), nil
		}
		if c == '\\' {
			parser.i++
			if parser.i >= len(parser.text) {
				return "", errors.New("bad escape")
			}
			esc := parser.text[parser.i]
			parser.i++
			switch esc {
			case '"', '\\', '/':
				buf.WriteByte(esc)
			case 'b':
				buf.WriteByte('\b')
			case 'f':
				buf.WriteByte('\f')
			case 'n':
				buf.WriteByte('\n')
			case 'r':
				buf.WriteByte('\r')
			case 't':
				buf.WriteByte('\t')
			case 'u':
				if parser.i+4 > len(parser.text) {
					return "", errors.New("bad unicode escape")
				}
				n, err := strconv.ParseInt(parser.text[parser.i:parser.i+4], 16, 32)
				if err != nil {
					return "", err
				}
				parser.i += 4
				runeValue := rune(n)
				if !utf8.ValidRune(runeValue) {
					return "", errors.New("bad unicode escape")
				}
				buf.WriteRune(runeValue)
			default:
				return "", errors.New("bad escape")
			}
			continue
		}
		buf.WriteByte(c)
		parser.i++
	}
	return "", errors.New("unterminated string")
}
