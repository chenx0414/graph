package graph

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const reviewModuleUsage = `Usage: graphd review-module --policy <policy.json> --entry <new-entry.mjs> [options]

Turns a review policy into an ordinary command module. The command writes the
isolated evaluate code to a new entry file and prints the module declaration
that connects it.

Options:
  --policy <path>        Review policy JSON (required)
  --entry <path>         Code entry to create (required; never overwritten)
  --version <n>          Module code version (default: 1)
  --protocol <name>      Protocol of the module ports (default: data)
  -h, --help             Print this help`

// reviewModuleDescriptor is the module declaration the command prints. The
// field order is the order the declaration reads in.
type reviewModuleDescriptor struct {
	Type           string           `json:"type"`
	Trigger        string           `json:"trigger"`
	RequiredInputs []string         `json:"requiredInputs"`
	Inputs         json.RawMessage  `json:"inputs"`
	Outputs        json.RawMessage  `json:"outputs"`
	Code           reviewModuleCode `json:"code"`
}

type reviewModuleCode struct {
	Entry   string `json:"entry"`
	Version int    `json:"version"`
}

// runReviewModule is the `graphd review-module` command. The policy rules
// live in core_review_policy.go; this is the entry point that can reach them.
func runReviewModule(args []string, cwd string) int {
	policyPath := ""
	entryPath := ""
	version := 1
	protocol := "data"
	for index := 0; index < len(args); index++ {
		argument := args[index]
		value := func() string {
			if index+1 >= len(args) {
				Raise("usage", argument+" requires a value")
			}
			index++
			return args[index]
		}
		switch argument {
		case "--policy":
			policyPath = value()
		case "--entry":
			entryPath = value()
		case "--version":
			version = reviewModuleVersion(value())
		case "--protocol":
			protocol = value()
		case "--help", "-h":
			fmt.Fprintln(os.Stdout, reviewModuleUsage)
			return 0
		default:
			Raise("usage", "Unknown argument: "+argument)
		}
	}
	if policyPath == "" || entryPath == "" {
		fmt.Fprintln(os.Stderr, reviewModuleUsage)
		return 2
	}
	if strings.TrimSpace(protocol) == "" {
		Raise("usage", "The protocol must be nonempty")
	}
	raw, err := os.ReadFile(resolvePath(cwd, policyPath))
	if err != nil {
		Raise("invalid_input", "The policy could not be read: "+err.Error())
	}
	var policy any
	if err := json.Unmarshal(raw, &policy); err != nil {
		Raise("invalid_definition", "The policy is not valid JSON: "+err.Error())
	}
	// The policy is checked before anything is written: a broken policy must
	// not leave a half-written entry behind.
	inputs := ReviewPolicyInputs(policy)
	code := ReviewPolicyCode(policy)
	entry := resolvePath(cwd, entryPath)
	if err := writeNewEntry(entry, code); err != nil {
		Raise("invalid_input", "The code entry could not be created: "+err.Error())
	}
	descriptor := reviewModuleDescriptor{
		Type:           "command",
		Trigger:        "each",
		RequiredInputs: inputs,
		Inputs:         reviewModulePorts(inputs, protocol),
		Outputs:        reviewModulePorts([]string{"approved", "rework"}, protocol),
		Code:           reviewModuleCode{Entry: entry, Version: version},
	}
	writeReviewModuleDescriptor(descriptor)
	return 0
}

// reviewModuleVersion reads the code version option.
func reviewModuleVersion(raw string) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		Raise("usage", "The module version must be a positive integer")
	}
	return value
}

// reviewModulePorts declares the given ports with one protocol, in the order
// they were named.
func reviewModulePorts(names []string, protocol string) json.RawMessage {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for index, name := range names {
		if index > 0 {
			buf.WriteByte(',')
		}
		key, _ := json.Marshal(name)
		buf.Write(key)
		buf.WriteString(":{\"protocol\":")
		value, _ := json.Marshal(protocol)
		buf.Write(value)
		buf.WriteByte('}')
	}
	buf.WriteByte('}')
	return json.RawMessage(buf.String())
}

// writeNewEntry writes the module code to a path that does not exist yet. A
// published code entry is never overwritten; a revision takes a new path.
func writeNewEntry(entry string, code string) error {
	return writeNewFile(entry, code, 0o600)
}

// writeNewFile writes content to a path that does not exist yet. An existing
// file is never overwritten.
func writeNewFile(path string, content string, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(content)
	return err
}

// writeReviewModuleDescriptor prints the module declaration.
func writeReviewModuleDescriptor(descriptor reviewModuleDescriptor) {
	raw, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		Raise("internal", "The module declaration could not be written: "+err.Error())
	}
	fmt.Fprintln(os.Stdout, string(raw))
}
