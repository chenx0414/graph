package graph

// The rule engine: a small language the graph's rules are written in.
//
// A rule says when something is true, and what to emit when it is. The
// parts are split by what they do: core_rule_parser.go reads the source
// into a tree, core_rule_evaluator.go walks that tree against an
// environment, and core_rule_emit.go reads the values a rule emits.
//
// The rules themselves - what they mean and how they merge - are here.
import (
	"fmt"
	"strings"
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
