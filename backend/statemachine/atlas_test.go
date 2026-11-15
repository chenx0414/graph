package statemachine

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

const atlasRewrite = "GRAPH_UPDATE_ATLAS"

type atlasDocument struct {
	path   string
	start  string
	end    string
	render func([]Machine) string
}

var atlasDocuments = []atlasDocument{
	{"../../docs/agent/state-machines.md", "<!-- atlas:table:start -->", "<!-- atlas:table:end -->", renderAtlasTable},
	{"../../docs/agent/state-machines-reference.md", "<!-- atlas:machines:start -->", "<!-- atlas:machines:end -->", renderAtlasMachines},
}

func TestAtlasMatchesRegistry(t *testing.T) {
	machines := All()
	if len(machines) == 0 {
		t.Fatal("the registry is empty")
	}
	for _, document := range atlasDocuments {
		verifyAtlasDocument(t, document, machines)
	}
}

func verifyAtlasDocument(t *testing.T, target atlasDocument, machines []Machine) {
	payload, err := os.ReadFile(target.path)
	if err != nil {
		t.Fatalf("read %s: %v", target.path, err)
	}
	body := string(payload)
	current, err := atlasBlock(body, target.start, target.end)
	if err != nil {
		t.Fatalf("%s: %v", target.path, err)
	}
	generated := target.render(machines)
	if strings.TrimRight(current, "\n") == strings.TrimRight(generated, "\n") {
		return
	}
	if os.Getenv(atlasRewrite) == "1" {
		if err := os.WriteFile(target.path, []byte(strings.Replace(body, current, generated, 1)), 0o644); err != nil {
			t.Fatalf("write %s: %v", target.path, err)
		}
		return
	}
	t.Fatalf("%s no longer matches machines.json\n  %s\nregenerate the atlas with: %s=1 go -C backend test ./statemachine -run Atlas",
		target.path, firstAtlasDifference(current, generated), atlasRewrite)
}

func atlasBlock(document, open, close string) (string, error) {
	start := strings.Index(document, open)
	if start < 0 {
		return "", fmt.Errorf("no %s marker", open)
	}
	end := strings.Index(document[start:], close)
	if end < 0 {
		return "", fmt.Errorf("no %s marker", close)
	}
	return document[start : start+end+len(close)], nil
}

func firstAtlasDifference(current, generated string) string {
	currentLines := strings.Split(current, "\n")
	generatedLines := strings.Split(generated, "\n")
	for index := 0; index < len(currentLines) && index < len(generatedLines); index++ {
		if currentLines[index] != generatedLines[index] {
			return fmt.Sprintf("line %d: atlas has %q, source has %q", index+1, currentLines[index], generatedLines[index])
		}
	}
	return fmt.Sprintf("atlas has %d lines, source has %d", len(currentLines), len(generatedLines))
}

func renderAtlasTable(machines []Machine) string {
	var builder strings.Builder
	builder.WriteString("<!-- atlas:table:start -->\n\n")
	builder.WriteString("| id | 机器 | 落库位置 | 状态数 | 初始 | 终态 |\n")
	builder.WriteString("| --- | --- | --- | --- | --- | --- |\n")
	for _, machine := range machines {
		builder.WriteString("| " + strings.Join([]string{
			code(machine.ID),
			machine.Title,
			atlasTargets(machine),
			fmt.Sprintf("%d", len(machine.States)),
			atlasNames(machine.Initial),
			atlasTerminal(machine),
		}, " | ") + " |\n")
	}
	builder.WriteString("\n<!-- atlas:table:end -->\n")
	return builder.String()
}

func renderAtlasMachines(machines []Machine) string {
	var builder strings.Builder
	builder.WriteString("<!-- atlas:machines:start -->\n")
	for _, machine := range machines {
		builder.WriteString("\n")
		builder.WriteString(atlasMachine(machine))
	}
	builder.WriteString("<!-- atlas:machines:end -->\n")
	return builder.String()
}

func atlasMachine(machine Machine) string {
	var builder strings.Builder
	builder.WriteString("### " + machine.ID + "\n\n")
	builder.WriteString("**" + machine.Title + "** · 存储：`" + machine.Store + "`")
	if machine.Owner != "" {
		builder.WriteString(" · 写入者：`" + machine.Owner + "`")
	}
	builder.WriteString("\n\n")
	if len(machine.Targets) > 0 {
		locations := []string{}
		for _, target := range machine.Targets {
			locations = append(locations, code(target.Table+"."+target.Column))
		}
		builder.WriteString("落库位置：" + strings.Join(locations, "、") + "\n\n")
	}
	builder.WriteString("初始：" + atlasNames(machine.Initial) + " · 终态：" + atlasTerminal(machine) + "\n\n")
	builder.WriteString("| state | 标签 | tone | 终态 |\n| --- | --- | --- | --- |\n")
	for _, state := range machine.States {
		tone := string(state.Tone)
		if tone == "" {
			tone = "—"
		}
		terminal := ""
		if state.Terminal {
			terminal = "是"
		}
		builder.WriteString("| " + state.Name + " | " + state.Label + " | " + tone + " | " + terminal + " |\n")
	}
	if len(machine.Transitions) > 0 {
		builder.WriteString("\n转移：\n\n")
		for _, transition := range machine.Transitions {
			line := "- " + code(transition.From) + " → " + code(transition.To)
			if transition.On != "" {
				line += " （" + transition.On + "）"
			}
			builder.WriteString(line + "\n")
		}
	}
	return builder.String()
}

func atlasTargets(machine Machine) string {
	if len(machine.Targets) == 0 {
		return "（派生，不落库）"
	}
	locations := []string{}
	for _, target := range machine.Targets {
		locations = append(locations, code(target.Table+"."+target.Column))
	}
	return strings.Join(locations, "、")
}

func atlasNames(names []string) string {
	if len(names) == 0 {
		return "（无）"
	}
	quoted := []string{}
	for _, name := range names {
		quoted = append(quoted, code(name))
	}
	return strings.Join(quoted, "、")
}

func atlasTerminal(machine Machine) string {
	names := []string{}
	for _, state := range machine.States {
		if state.Terminal {
			names = append(names, state.Name)
		}
	}
	if len(names) == 0 {
		return "（无）"
	}
	return atlasNames(names)
}

func code(value string) string {
	return "`" + value + "`"
}
