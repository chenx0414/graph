package harness

type Step struct {
	Rule      string         `json:"rule"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}

type Case struct {
	ID        string            `json:"id"`
	Prompt    string            `json:"prompt"`
	Files     map[string]string `json:"files"`
	Protected []string          `json:"protected"`
	Verify    []string          `json:"verify"`
	Expected  []string          `json:"expected"`
	Forbidden []string          `json:"forbidden"`
	Steps     []Step            `json:"steps"`
}

const moduleFile = "module example\n\ngo 1.24\n"

const parserSource = `package example

import "strings"

func ParseConfig(text string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		parts := strings.Split(line, "=")
		values[parts[0]] = parts[1]
	}
	return values
}
`

const parserTest = `package example

import "testing"

func TestParseConfig(t *testing.T) {
	got := ParseConfig("A=one=two\n\nB=3\n")
	if len(got) != 2 || got["A"] != "one=two" || got["B"] != "3" {
		t.Fatalf("ParseConfig kept %v", got)
	}
	if len(ParseConfig("")) != 0 {
		t.Fatalf("an empty document has no settings")
	}
}
`

const greeterSource = `package main

import (
	"fmt"
	"io"
	"os"
)

func greet(args []string, out io.Writer) int {
	fmt.Fprintln(out, "hello")
	return 0
}

func main() {
	os.Exit(greet(os.Args[1:], os.Stdout))
}
`

const greeterTest = `package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestGreetRepeatsOnCount(t *testing.T) {
	out := &bytes.Buffer{}
	if code := greet(nil, out); code != 0 || out.String() != "hello\n" {
		t.Fatalf("default output was %q with code %d", out.String(), code)
	}
	out.Reset()
	if code := greet([]string{"--count", "3"}, out); code != 0 || out.String() != strings.Repeat("hello\n", 3) {
		t.Fatalf("counted output was %q with code %d", out.String(), code)
	}
	for _, args := range [][]string{{"--count", "no"}, {"--count", "-1"}, {"--count", "1.5"}, {"--count"}} {
		out.Reset()
		if code := greet(args, out); code == 0 {
			t.Fatalf("%v was accepted", args)
		}
	}
}
`

const counterSource = `package main

import (
	"fmt"
	"io"
	"os"
)

func next(statePath string) (int, error) {
	return 1, nil
}

func main() {
	count, err := next(os.Args[1])
	if err != nil {
		os.Exit(1)
	}
	fmt.Fprintln(io.Writer(os.Stdout), count)
}
`

const counterTest = `package main

import (
	"path/filepath"
	"testing"
)

func TestNextContinuesFromTheSavedFile(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "count.json")
	for expected := 1; expected <= 3; expected++ {
		count, err := next(statePath)
		if err != nil {
			t.Fatalf("run %d: %v", expected, err)
		}
		if count != expected {
			t.Fatalf("run %d counted %d", expected, count)
		}
	}
}
`

var preciseEditDiscipline = []string{"read", "edit", "read"}

var forbiddenRewrite = []string{"write"}

func editStep(path string, edits ...map[string]string) Step {
	list := make([]any, 0, len(edits))
	for _, edit := range edits {
		list = append(list, edit)
	}
	return Step{Rule: "edit", Tool: "edit", Arguments: map[string]any{"path": path, "edits": list}}
}

func readStep(path string) Step {
	return Step{Rule: "read", Tool: "read", Arguments: map[string]any{"path": path}}
}

var Cases = map[string]Case{
	"parser": {
		ID:     "parser",
		Prompt: "修一下 config.go：空白行不该变成配置，值里的等号要保留。",
		Files: map[string]string{
			"go.mod":         moduleFile,
			"config.go":      parserSource,
			"config_test.go": parserTest,
		},
		Protected: []string{"config_test.go"},
		Verify:    []string{"go", "test", "./..."},
		Expected:  preciseEditDiscipline,
		Forbidden: forbiddenRewrite,
		Steps: []Step{
			readStep("config.go"),
			editStep("config.go", map[string]string{
				"oldText": "	for _, line := range strings.Split(text, \"\\n\") {\n		parts := strings.Split(line, \"=\")\n		values[parts[0]] = parts[1]\n	}",
				"newText": "	for _, line := range strings.Split(text, \"\\n\") {\n		if strings.TrimSpace(line) == \"\" {\n			continue\n		}\n		key, value, _ := strings.Cut(line, \"=\")\n		values[key] = value\n	}",
			}),
			readStep("config.go"),
		},
	},
	"cli": {
		ID:     "cli",
		Prompt: "给 greet 加 --count 参数重复输出，默认行为别变。非法值要报错退出。",
		Files: map[string]string{
			"go.mod":       moduleFile,
			"main.go":      greeterSource,
			"main_test.go": greeterTest,
		},
		Protected: []string{"main_test.go"},
		Verify:    []string{"go", "test", "./..."},
		Expected:  preciseEditDiscipline,
		Forbidden: forbiddenRewrite,
		Steps: []Step{
			readStep("main.go"),
			editStep("main.go",
				map[string]string{
					"oldText": "func greet(args []string, out io.Writer) int {\n\tfmt.Fprintln(out, \"hello\")\n\treturn 0\n}",
					"newText": "func greet(args []string, out io.Writer) int {\n\tcount := 1\n\tif len(args) > 0 {\n\t\tif len(args) != 2 || args[0] != \"--count\" {\n\t\t\tfmt.Fprintln(os.Stderr, \"Invalid count\")\n\t\t\treturn 1\n\t\t}\n\t\tparsed, err := strconv.Atoi(args[1])\n\t\tif err != nil || parsed < 1 {\n\t\t\tfmt.Fprintln(os.Stderr, \"Invalid count\")\n\t\t\treturn 1\n\t\t}\n\t\tcount = parsed\n\t}\n\tfor index := 0; index < count; index++ {\n\t\tfmt.Fprintln(out, \"hello\")\n\t}\n\treturn 0\n}",
				},
				map[string]string{
					"oldText": "\t\"io\"\n\t\"os\"\n)",
					"newText": "\t\"io\"\n\t\"os\"\n\t\"strconv\"\n)",
				},
			),
			readStep("main.go"),
		},
	},
	"persistence": {
		ID:     "persistence",
		Prompt: "counter 没保存指定的状态文件，修一下，重启后也要接着计数。",
		Files: map[string]string{
			"go.mod":          moduleFile,
			"counter.go":      counterSource,
			"counter_test.go": counterTest,
		},
		Protected: []string{"counter_test.go"},
		Verify:    []string{"go", "test", "./..."},
		Expected:  preciseEditDiscipline,
		Forbidden: forbiddenRewrite,
		Steps: []Step{
			readStep("counter.go"),
			editStep("counter.go",
				map[string]string{
					"oldText": "func next(statePath string) (int, error) {\n\treturn 1, nil\n}",
					"newText": "func next(statePath string) (int, error) {\n\tcount := 0\n\tif payload, err := os.ReadFile(statePath); err == nil {\n\t\tcount, _ = strconv.Atoi(strings.TrimSpace(string(payload)))\n\t}\n\tcount++\n\tif err := os.WriteFile(statePath, []byte(strconv.Itoa(count)), 0o644); err != nil {\n\t\treturn 0, err\n\t}\n\treturn count, nil\n}",
				},
				map[string]string{
					"oldText": "\t\"io\"\n\t\"os\"\n)",
					"newText": "\t\"io\"\n\t\"os\"\n\t\"strconv\"\n\t\"strings\"\n)",
				},
			),
			readStep("counter.go"),
		},
	},
}

var CaseOrder = []string{"parser", "cli", "persistence"}
