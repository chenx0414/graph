package main

import (
	"flag"
	"fmt"
	"image/png"
	"os"
	"strings"

	"github.com/egoist/mygo/ui"
)

type driveFlags struct {
	address string
	token   string
	width   int
	height  int
	steps   []string
}

func runDriveCommand(args []string) int {
	flags := driveFlags{}
	set := flag.NewFlagSet("drive", flag.ContinueOnError)
	set.StringVar(&flags.address, "address", "", "the daemon address to render against")
	set.StringVar(&flags.token, "token", "", "the session token for that daemon")
	set.IntVar(&flags.width, "width", 1100, "window width in DIPs")
	set.IntVar(&flags.height, "height", 760, "window height in DIPs")
	steps := strings.Builder{}
	set.Var(&stringList{target: &steps}, "step", "one step; repeat for each")
	if err := set.Parse(args); err != nil {
		return 2
	}
	flags.steps = splitSteps(steps.String())
	if len(flags.steps) == 0 {
		fmt.Fprintln(os.Stderr, "graphdrive: at least one --step is required")
		return 2
	}

	shell := newShellState(flags.address, flags.token)
	tester := ui.NewTester(shell.view, flags.width, flags.height)
	tester.Frame()

	for index, step := range flags.steps {
		if err := runStep(tester, step); err != nil {
			fmt.Fprintf(os.Stderr, "graphdrive: step %d (%s): %v\n", index+1, step, err)
			return 1
		}
	}
	return 0
}

func runStep(tester *ui.Tester, step string) error {
	verb, argument, _ := strings.Cut(step, " ")
	argument = strings.Trim(strings.TrimSpace(argument), `"'`)
	switch verb {
	case "has":
		if !tester.HasText(argument) {
			return fmt.Errorf("the interface does not show %q", argument)
		}
		return nil
	case "click":
		return tester.Click(argument)
	case "type":
		tester.Type(argument)
		tester.Frame()
		return nil
	case "frame":
		tester.Frame()
		return nil
	case "texts":
		for _, text := range tester.Texts() {
			fmt.Println(text)
		}
		return nil
	case "key":
		return fmt.Errorf("key steps are not carried out yet")
	case "shot":
		picture := tester.Image()
		if picture == nil {
			return fmt.Errorf("the window rendered nothing")
		}
		file, err := os.Create(argument)
		if err != nil {
			return err
		}
		defer file.Close()
		return png.Encode(file, picture)
	}
	return fmt.Errorf("unknown step verb %q", verb)
}

func splitSteps(raw string) []string {
	steps := []string{}
	for _, line := range strings.Split(raw, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			steps = append(steps, trimmed)
		}
	}
	return steps
}

type stringList struct{ target *strings.Builder }

func (l *stringList) String() string {
	if l == nil || l.target == nil {
		return ""
	}
	return l.target.String()
}

func (l *stringList) Set(value string) error {
	if l.target.Len() > 0 {
		l.target.WriteString("\n")
	}
	l.target.WriteString(value)
	return nil
}
