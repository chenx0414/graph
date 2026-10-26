package graph

import (
	"fmt"
	"strings"
)

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

type RuleEnvironment struct {
	Inputs map[string]any
	State  any
}

type ParsedRule struct {
	Source           string
	ReferencedInputs []string
	Evaluate         func(RuleEnvironment) bool
}

type EmitValue struct {
	Kind   string
	Input  string
	Path   string
	Value  any
	Fields map[string]EmitValue
}

type RuleDeclaration struct {
	When   ParsedRule
	Emit   map[string]EmitValue
	Reason string
}

type MergedOutput struct {
	Emitted bool
	Outputs map[string]any
	Reasons []string
}

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
