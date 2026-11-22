package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/chenx0414/graph/backend/internal/harness"
)

type connection struct {
	address string
	token   string
}

func (c connection) session() *harness.CLISession {
	return harness.NewCLISession(c.address, c.token)
}

func parseConnection(name string) (*connection, *flag.FlagSet) {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	conn := &connection{}
	set.StringVar(&conn.address, "address", "", "the daemon address")
	set.StringVar(&conn.token, "token", "", "the session token")
	return conn, set
}

func finishConnection(name string, conn *connection, set *flag.FlagSet, args []string) bool {
	if err := set.Parse(args); err != nil {
		return false
	}
	if conn.address == "" {
		fmt.Fprintf(os.Stderr, "graphcli %s: --address is required\n", name)
		return false
	}
	return true
}

func runHealth(args []string) int {
	conn, set := parseConnection("health")
	if !finishConnection("health", conn, set, args) {
		return 2
	}
	healthy, err := conn.session().Healthy()
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcli health: %v\n", err)
		return 1
	}
	if !healthy {
		fmt.Fprintln(os.Stderr, "graphcli health: the daemon is not answering")
		return 1
	}
	return printJSON(map[string]any{"healthy": true, "address": conn.address})
}

func runOpen(args []string) int {
	conn, set := parseConnection("open")

	title := set.String("title", "cli", "conversation title")
	text := set.String("text", "", "the first message")
	if !finishConnection("open", conn, set, args) {
		return 2
	}
	if *text == "" {
		fmt.Fprintln(os.Stderr, "graphcli open: --text is required; a conversation needs a first message")
		return 2
	}
	created, err := conn.session().CreateConversation(*title, *text)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcli open: %v\n", err)
		return 1
	}
	return printJSON(created)
}

func runSend(args []string) int {
	conn, set := parseConnection("send")

	conversation := set.String("conversation", "", "conversation id")
	text := set.String("text", "", "the message")
	if !finishConnection("send", conn, set, args) {
		return 2
	}
	if *conversation == "" || *text == "" {
		fmt.Fprintln(os.Stderr, "graphcli send: --conversation and --text are required")
		return 2
	}
	sent, err := conn.session().SendMessage(*conversation, *text)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcli send: %v\n", err)
		return 1
	}
	return printJSON(sent)
}

func runRead(args []string) int {
	conn, set := parseConnection("read")

	conversation := set.String("conversation", "", "conversation id")
	if !finishConnection("read", conn, set, args) {
		return 2
	}
	if *conversation == "" {
		fmt.Fprintln(os.Stderr, "graphcli read: --conversation is required")
		return 2
	}
	transcript, err := conn.session().ReadConversation(*conversation)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graphcli read: %v\n", err)
		return 1
	}
	return printJSON(transcript)
}

func runShot(args []string) int {
	conn, set := parseConnection("shot")

	output := set.String("out", "", "the PNG file to write")
	width := set.Int("width", 1100, "window width in DIPs")
	height := set.Int("height", 760, "window height in DIPs")
	if !finishConnection("shot", conn, set, args) {
		return 2
	}
	if *output == "" {
		fmt.Fprintln(os.Stderr, "graphcli shot: --out is required")
		return 2
	}
	if err := conn.session().Screenshot(*output, *width, *height); err != nil {
		fmt.Fprintf(os.Stderr, "graphcli shot: %v\n", err)
		return 1
	}
	return printJSON(map[string]any{"out": *output, "width": *width, "height": *height})
}
