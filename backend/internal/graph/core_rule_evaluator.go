package graph

// Walking a rule's tree against an environment.
//
// The environment says which facts are present and what they are; the
// evaluator says whether the rule holds.
import (
	"encoding/json"
	"strconv"
)

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
