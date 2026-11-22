package main

// The CLI an Agent drives: this is the "screenshot" verb of the verification CLI, living in the
// app module because only this module has the window and the ui package. It renders the real
// shell against a running daemon and writes the pixels, which is the evidence a unit test cannot
// produce.
//
// The verification CLI (backend/internal/harness) runs this binary as a subprocess for its
// screenshot capability: the dependency only points this way, app -> backend, so the harness
// cannot import the window and the window does not need to know who is looking at it.

import (
	"flag"
	"fmt"
	"image/png"
	"os"

	"github.com/egoist/mygo/ui"
)

type screenshotFlags struct {
	address string
	token   string
	output  string
	width   int
	height  int
}

// runScreenshotCommand renders the shell once and writes a PNG. It returns the process exit code.
func runScreenshotCommand(args []string) int {
	flags := screenshotFlags{}
	set := flag.NewFlagSet("screenshot", flag.ContinueOnError)
	set.StringVar(&flags.address, "address", "", "the daemon address to render against")
	set.StringVar(&flags.token, "token", "", "the session token for that daemon")
	set.StringVar(&flags.output, "out", "", "the PNG file to write")
	set.IntVar(&flags.width, "width", 1100, "window width in DIPs")
	set.IntVar(&flags.height, "height", 760, "window height in DIPs")
	if err := set.Parse(args); err != nil {
		return 2
	}
	if flags.output == "" {
		fmt.Fprintln(os.Stderr, "graphshot: --out is required")
		return 2
	}

	shell := newShellState(flags.address, flags.token)
	tester := ui.NewTester(shell.view, flags.width, flags.height)
	for frame := 0; frame < 3; frame++ {
		tester.Frame()
	}

	picture := tester.Image()
	if picture == nil {
		fmt.Fprintln(os.Stderr, "graphshot: the window rendered nothing")
		return 1
	}
	file, err := os.Create(flags.output)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphshot: %v\n", err)
		return 1
	}
	defer file.Close()
	if err := png.Encode(file, picture); err != nil {
		fmt.Fprintf(os.Stderr, "graphshot: %v\n", err)
		return 1
	}
	return 0
}
