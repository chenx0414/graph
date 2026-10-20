package graph

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// RuleError is a rule-language defect. It is not a RuntimeError.
type RuleError struct{ Message string }

func (e *RuleError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func rulePanic(message string) {
	panic(&RuleError{Message: message})
}

// RuleEnvironment is the inputs and module state a rule may read.
type RuleEnvironment struct {
	Inputs map[string]any
	State  any
}

// ParsedRule is an expression that never evals code.
type ParsedRule struct {
	Source           string
	ReferencedInputs []string
	Evaluate         func(RuleEnvironment) bool
}

// EmitValue is one declared output expression.
type EmitValue struct {
	Kind   string
	Input  string
	Path   string
	Value  any
	Fields map[string]EmitValue
}

// RuleDeclaration is one when/emit pair.
type RuleDeclaration struct {
	When   ParsedRule
	Emit   map[string]EmitValue
	Reason string
}

// MergedOutput is every matching rule's outputs in declaration order.
type MergedOutput struct {
	Emitted bool
	Outputs map[string]any
	Reasons []string
}

type ruleToken struct {
	Type  string
	Value string
	Num   float64
	Bool  bool
}

func ruleIdentStart(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || r == '_' || r == '$'
}

func ruleIdentPart(r rune) bool {
	return ruleIdentStart(r) || (r >= '0' && r <= '9')
}

func tokenizeRule(source string) []ruleToken {
	tokens := []ruleToken{}
	index := 0
	for index < len(source) {
		char := source[index]
		if char == ' ' || char == '\t' || char == '\n' {
			index++
			continue
		}
		if char == '(' {
			tokens = append(tokens, ruleToken{Type: "lparen"})
			index++
			continue
		}
		if char == ')' {
			tokens = append(tokens, ruleToken{Type: "rparen"})
			index++
			continue
		}
		if char == ',' {
			tokens = append(tokens, ruleToken{Type: "comma"})
			index++
			continue
		}
		if strings.HasPrefix(source[index:], "&&") {
			tokens = append(tokens, ruleToken{Type: "and"})
			index += 2
			continue
		}
		if strings.HasPrefix(source[index:], "||") {
			tokens = append(tokens, ruleToken{Type: "or"})
			index += 2
			continue
		}
		if char == '!' {
			if index+1 < len(source) && source[index+1] == '=' {
				tokens = append(tokens, ruleToken{Type: "op", Value: "!="})
				index += 2
				continue
			}
			tokens = append(tokens, ruleToken{Type: "not"})
			index++
			continue
		}
		if char == '=' && index+1 < len(source) && source[index+1] == '=' {
			tokens = append(tokens, ruleToken{Type: "op", Value: "=="})
			index += 2
			continue
		}
		if char == '=' {
			rulePanic("Rules compare with ==, not a single =")
		}
		if char == '>' || char == '<' {
			if index+1 < len(source) && source[index+1] == '=' {
				tokens = append(tokens, ruleToken{Type: "op", Value: string(char) + "="})
				index += 2
				continue
			}
			tokens = append(tokens, ruleToken{Type: "op", Value: string(char)})
			index++
			continue
		}
		if char == '"' || char == '\'' {
			value := ""
			index++
			for index < len(source) && source[index] != char {
				value += string(source[index])
				index++
			}
			if index >= len(source) || source[index] != char {
				rulePanic("Unterminated string literal in rule")
			}
			index++
			tokens = append(tokens, ruleToken{Type: "string", Value: value})
			continue
		}
		if char >= '0' && char <= '9' {
			value := ""
			for index < len(source) && ((source[index] >= '0' && source[index] <= '9') || source[index] == '.') {
				value += string(source[index])
				index++
			}
			number, err := strconv.ParseFloat(value, 64)
			if err != nil {
				rulePanic("Invalid number literal " + value)
			}
			tokens = append(tokens, ruleToken{Type: "number", Num: number})
			continue
		}
		r, _ := utf8.DecodeRuneInString(source[index:])
		if ruleIdentStart(r) {
			value := ""
			for index < len(source) {
				next, width := utf8.DecodeRuneInString(source[index:])
				if !ruleIdentPart(next) && next != '.' {
					break
				}
				value += string(next)
				index += width
			}
			if value == "true" || value == "false" {
				tokens = append(tokens, ruleToken{Type: "bool", Bool: value == "true"})
				continue
			}
			if value == "null" {
				tokens = append(tokens, ruleToken{Type: "null"})
				continue
			}
			tokens = append(tokens, ruleToken{Type: "ref", Value: value})
			continue
		}
		rulePanic("Unexpected character " + ruleJSON(string(char)) + " in rule")
	}
	return tokens
}

type ruleNode struct {
	Kind    string
	Value   any
	Path    []string
	Input   string
	Negated bool
	Inner   *ruleNode
	Left    *ruleNode
	Right   *ruleNode
	Op      string
}

type ruleParser struct {
	position int
	refs     []string
	seen     map[string]bool
	tokens   []ruleToken
	source   string
}

func (parser *ruleParser) peek() *ruleToken {
	if parser.position >= len(parser.tokens) {
		return nil
	}
	token := parser.tokens[parser.position]
	return &token
}

func (parser *ruleParser) next() ruleToken {
	token := parser.peek()
	if token == nil {
		rulePanic("Rule ended early: " + ruleJSON(parser.source))
	}
	parser.position++
	return *token
}

func (parser *ruleParser) addRef(name string) {
	if !parser.seen[name] {
		parser.seen[name] = true
		parser.refs = append(parser.refs, name)
	}
}

func (parser *ruleParser) parse() (*ruleNode, []string) {
	node := parser.parseOr()
	if parser.position != len(parser.tokens) {
		rulePanic("Unexpected trailing tokens in rule " + ruleJSON(parser.source))
	}
	return node, parser.refs
}

func (parser *ruleParser) parseOr() *ruleNode {
	left := parser.parseAnd()
	for parser.peek() != nil && parser.peek().Type == "or" {
		parser.next()
		left = &ruleNode{Kind: "or", Left: left, Right: parser.parseAnd()}
	}
	return left
}

func (parser *ruleParser) parseAnd() *ruleNode {
	left := parser.parseNot()
	for parser.peek() != nil && parser.peek().Type == "and" {
		parser.next()
		left = &ruleNode{Kind: "and", Left: left, Right: parser.parseNot()}
	}
	return left
}

func (parser *ruleParser) parseNot() *ruleNode {
	if parser.peek() != nil && parser.peek().Type == "not" {
		parser.next()
		return &ruleNode{Kind: "not", Inner: parser.parseNot()}
	}
	return parser.parseCompare()
}

func (parser *ruleParser) parseCompare() *ruleNode {
	left := parser.parsePrimary()
	token := parser.peek()
	if token != nil && token.Type == "op" {
		parser.next()
		return &ruleNode{Kind: "compare", Op: token.Value, Left: left, Right: parser.parsePrimary()}
	}
	return left
}

func (parser *ruleParser) parsePrimary() *ruleNode {
	token := parser.next()
	if token.Type == "lparen" {
		inner := parser.parseOr()
		close := parser.next()
		if close.Type != "rparen" {
			rulePanic("Missing ) in rule")
		}
		return inner
	}
	if token.Type == "string" {
		return &ruleNode{Kind: "literal", Value: token.Value}
	}
	if token.Type == "number" {
		return &ruleNode{Kind: "literal", Value: token.Num}
	}
	if token.Type == "bool" {
		return &ruleNode{Kind: "literal", Value: token.Bool}
	}
	if token.Type == "null" {
		return &ruleNode{Kind: "literal", Value: nil}
	}
	if token.Type == "ref" {
		if token.Value == "$exists" || token.Value == "exists" || token.Value == "$missing" || token.Value == "missing" {
			open := parser.next()
			if open.Type != "lparen" {
				rulePanic(token.Value + " must be called with ( )")
			}
			arg := parser.next()
			if arg.Type != "ref" {
				rulePanic(token.Value + " expects an input name")
			}
			close := parser.next()
			if close.Type != "rparen" {
				rulePanic("Missing ) after " + token.Value)
			}
			input := strings.Split(arg.Value, ".")[0]
			parser.addRef(input)
			return &ruleNode{Kind: "exists", Input: input, Negated: token.Value == "$missing" || token.Value == "missing"}
		}
		path := strings.Split(token.Value, ".")
		parser.addRef(path[0])
		return &ruleNode{Kind: "ref", Path: path}
	}
	rulePanic("Unexpected token in rule " + ruleJSON(parser.source))
	return nil
}

func ruleReadPath(path []string, environment RuleEnvironment) (bool, any) {
	var current any
	if path[0] == "state" {
		current = environment.State
	} else {
		value, ok := environment.Inputs[path[0]]
		if !ok {
			return false, nil
		}
		current = value
	}
	for index := 1; index < len(path); index++ {
		object, ok := current.(map[string]any)
		if !ok || current == nil {
			return false, nil
		}
		value, ok := object[path[index]]
		if !ok {
			return false, nil
		}
		current = value
	}
	return true, current
}

func ruleTruthy(value any, present bool) bool {
	if !present || value == nil {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case float64:
		return typed != 0
	case int:
		return typed != 0
	case string:
		return len(typed) > 0
	case []any:
		return len(typed) > 0
	default:
		return true
	}
}

func ruleJSON(value any) string {
	// TODO(port): encoding/json sorts object keys. TypeScript JSON.stringify keeps insertion order.
	raw, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(raw)
}

func ruleNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case string:
		number, err := strconv.ParseFloat(typed, 64)
		return number, err == nil
	default:
		return 0, false
	}
}

func ruleCompare(op string, left, right any, leftPresent, rightPresent bool) bool {
	if op == "==" {
		return ruleJSON(left) == ruleJSON(right)
	}
	if op == "!=" {
		return ruleJSON(left) != ruleJSON(right)
	}
	if !leftPresent || !rightPresent || left == nil || right == nil {
		return false
	}
	leftString, leftIsString := left.(string)
	rightString, rightIsString := right.(string)
	if leftIsString && rightIsString {
		switch op {
		case ">":
			return leftString > rightString
		case ">=":
			return leftString >= rightString
		case "<":
			return leftString < rightString
		case "<=":
			return leftString <= rightString
		}
	}
	a, aok := ruleNumber(left)
	b, bok := ruleNumber(right)
	if !aok || !bok {
		return false
	}
	switch op {
	case ">":
		return a > b
	case ">=":
		return a >= b
	case "<":
		return a < b
	case "<=":
		return a <= b
	}
	rulePanic("Unsupported comparison " + op)
	return false
}

type ruleValue struct {
	present bool
	value   any
}

func evaluateRuleNode(node *ruleNode, environment RuleEnvironment) ruleValue {
	switch node.Kind {
	case "literal":
		return ruleValue{present: true, value: node.Value}
	case "ref":
		found, value := ruleReadPath(node.Path, environment)
		if !found {
			return ruleValue{present: true, value: nil}
		}
		return ruleValue{present: true, value: value}
	case "exists":
		if node.Input == "state" {
			// A decoded null state is still defined. Missing means the key was never supplied.
			present := true
			if node.Negated {
				return ruleValue{present: true, value: !present}
			}
			return ruleValue{present: true, value: present}
		}
		_, present := environment.Inputs[node.Input]
		if node.Negated {
			return ruleValue{present: true, value: !present}
		}
		return ruleValue{present: true, value: present}
	case "not":
		inner := evaluateRuleNode(node.Inner, environment)
		return ruleValue{present: true, value: !ruleTruthy(inner.value, inner.present)}
	case "and":
		left := evaluateRuleNode(node.Left, environment)
		if !ruleTruthy(left.value, left.present) {
			return ruleValue{present: true, value: false}
		}
		right := evaluateRuleNode(node.Right, environment)
		return ruleValue{present: true, value: ruleTruthy(right.value, right.present)}
	case "or":
		left := evaluateRuleNode(node.Left, environment)
		if ruleTruthy(left.value, left.present) {
			return ruleValue{present: true, value: true}
		}
		right := evaluateRuleNode(node.Right, environment)
		return ruleValue{present: true, value: ruleTruthy(right.value, right.present)}
	case "compare":
		left := evaluateRuleNode(node.Left, environment)
		right := evaluateRuleNode(node.Right, environment)
		return ruleValue{present: true, value: ruleCompare(node.Op, left.value, right.value, left.present, right.present)}
	default:
		return ruleValue{}
	}
}

// ParseRule parses a rule expression. A defect panics with *RuleError.
func ParseRule(source string) ParsedRule {
	if strings.TrimSpace(source) == "" {
		rulePanic("A rule requires a nonempty expression")
	}
	parser := &ruleParser{tokens: tokenizeRule(source), source: source, seen: map[string]bool{}}
	node, refs := parser.parse()
	referenced := []string{}
	for _, name := range refs {
		if name != "state" {
			referenced = append(referenced, name)
		}
	}
	return ParsedRule{
		Source:           source,
		ReferencedInputs: referenced,
		Evaluate: func(environment RuleEnvironment) bool {
			value := evaluateRuleNode(node, environment)
			return ruleTruthy(value.value, value.present)
		},
	}
}

// ResolveEmit evaluates one emit expression.
func ResolveEmit(value EmitValue, environment RuleEnvironment) any {
	switch value.Kind {
	case "literal":
		return value.Value
	case "forward":
		if item, ok := environment.Inputs[value.Input]; ok {
			return item
		}
		return nil
	case "field":
		found, read := ruleReadPath(strings.Split(value.Path, "."), environment)
		if found {
			return read
		}
		return nil
	case "object":
		out := map[string]any{}
		for key, child := range value.Fields {
			out[key] = ResolveEmit(child, environment)
		}
		return out
	default:
		return nil
	}
}

// ParseEmit translates a definition emit map into typed emit values.
func ParseEmit(source map[string]any) map[string]EmitValue {
	out := map[string]EmitValue{}
	for port, value := range source {
		out[port] = parseEmitValue(value)
	}
	return out
}

func parseEmitValue(value any) EmitValue {
	if text, ok := value.(string); ok {
		if strings.HasPrefix(text, "$") {
			return EmitValue{Kind: "forward", Input: text[1:]}
		}
		if emitFieldPattern(text) {
			return EmitValue{Kind: "field", Path: text}
		}
		return EmitValue{Kind: "literal", Value: text}
	}
	object, ok := value.(map[string]any)
	if ok {
		fields := map[string]EmitValue{}
		for key, child := range object {
			fields[key] = parseEmitValue(child)
		}
		return EmitValue{Kind: "object", Fields: fields}
	}
	return EmitValue{Kind: "literal", Value: value}
}

func emitFieldPattern(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	for index, part := range parts {
		if part == "" {
			return false
		}
		for i, r := range part {
			if i == 0 {
				if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || r == '_') {
					return false
				}
				continue
			}
			if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_') {
				return false
			}
		}
		_ = index
	}
	return true
}

// MergeRuleOutputs runs every matching rule. Two rules claiming one port panic.
func MergeRuleOutputs(rules []RuleDeclaration, environment RuleEnvironment) MergedOutput {
	claimed := map[string]int{}
	for index, rule := range rules {
		for port := range rule.Emit {
			if prior, ok := claimed[port]; ok {
				rulePanic(fmt.Sprintf("Rules %d and %d both emit output %s; the same output may only be claimed once", prior, index, port))
			}
			claimed[port] = index
		}
	}
	outputs := map[string]any{}
	reasons := []string{}
	emitted := false
	for _, rule := range rules {
		if !rule.When.Evaluate(environment) {
			continue
		}
		emitted = true
		if rule.Reason != "" {
			reasons = append(reasons, rule.Reason)
		} else {
			reasons = append(reasons, rule.When.Source)
		}
		for port, value := range rule.Emit {
			outputs[port] = ResolveEmit(value, environment)
		}
	}
	return MergedOutput{Emitted: emitted, Outputs: outputs, Reasons: reasons}
}
