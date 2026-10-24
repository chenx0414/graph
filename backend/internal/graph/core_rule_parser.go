package graph

// Reading a rule's source into a tree.
//
// The tokenizer keeps the source order, because the order is part of how
// a rule reads: the first thing that is true wins.
import (
	"strconv"
	"strings"
	"unicode/utf8"
)

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
