package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An Agent has to be able to drive the real app, not only call functions in a test binary:
// VDD asks for a CLI that can do business operations and then prove the result. Each of these
// assertions describes something the CLI itself must be able to do, and each fails when the CLI
// is broken rather than when the product is.
//
// The CLI is exercised as a subprocess, the way an Agent uses it: arguments in, exit code and
// JSON out. A helper called in-process would not prove the command exists.

func cliSessionRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	return root
}

// A fresh environment is a precondition of every self-verification run: the daemon needs a state
// directory it owns, and the run must not inherit the user's real history.
func TestTheCLIRunsASessionInAnEnvironmentItCreated(t *testing.T) {
	root := cliSessionRoot(t)
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a CLI session: %v", err)
	}
	defer session.Close()

	if session.URL() == "" {
		t.Fatalf("the session reports the address it is serving on")
	}
	if _, err := os.Stat(filepath.Join(root, "state")); err != nil {
		t.Fatalf("the session created its own state directory: %v", err)
	}
	if healthy, err := session.Healthy(); err != nil || !healthy {
		t.Fatalf("the session answers its health check, err=%v healthy=%v", err, healthy)
	}
}

// The business operation VDD names first: create a conversation and send a message to it.
func TestTheCLICreatesAConversationAndSendsAMessage(t *testing.T) {
	root := cliSessionRoot(t)
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a CLI session: %v", err)
	}
	defer session.Close()

	conversation, err := session.CreateConversation("self-verification", "第一条消息")
	if err != nil {
		t.Fatalf("create a conversation: %v", err)
	}
	if conversation.ID == "" {
		t.Fatalf("a created conversation has an id to address it by")
	}
	message, err := session.SendMessage(conversation.ID, "从 CLI 发出的第一条消息")
	if err != nil {
		t.Fatalf("send a message: %v", err)
	}
	if message.ID == "" {
		t.Fatalf("a sent message has an id")
	}
	// Reading it back is what proves the message was stored and not merely accepted.
	read, err := session.ReadConversation(conversation.ID)
	if err != nil {
		t.Fatalf("read the conversation back: %v", err)
	}
	found := false
	for _, entry := range read.Messages {
		if entry.ID == message.ID {
			found = true
			if !strings.Contains(entry.Text, "从 CLI 发出") {
				t.Fatalf("the stored message keeps its text, got %q", entry.Text)
			}
		}
	}
	if !found {
		t.Fatalf("the message the CLI sent is in the conversation it sent it to, got %d messages", len(read.Messages))
	}
}

// Evidence: a screenshot of the real window, which is the part no unit test can produce.
func TestTheCLITakesAScreenshotOfTheRealWindow(t *testing.T) {
	root := cliSessionRoot(t)
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a CLI session: %v", err)
	}
	defer session.Close()

	output := filepath.Join(root, "window.png")
	if err := session.Screenshot(output); err != nil {
		t.Fatalf("take a screenshot: %v", err)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatalf("the screenshot is written where it was asked to be: %v", err)
	}
	if info.Size() == 0 {
		t.Fatalf("the screenshot is not an empty file")
	}
	source, err := decodePNGFile(output)
	if err != nil {
		t.Fatalf("the screenshot is a readable picture: %v", err)
	}
	width, height := source.Bounds().Dx(), source.Bounds().Dy()
	if width < 200 || height < 200 {
		t.Fatalf("the screenshot is the size of a window, got %dx%d", width, height)
	}
	// A blank canvas is also "a PNG of the right size". What makes this evidence is that the
	// window actually drew: real UI has many distinct colours, an empty buffer has one.
	distinct := map[uint32]bool{}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r, g, b, _ := source.At(x, y).RGBA()
			distinct[uint32(r>>8)<<16|uint32(g>>8)<<8|uint32(b>>8)] = true
		}
	}
	if len(distinct) < 8 {
		t.Fatalf("the screenshot drew only %d distinct colours, so nothing was rendered", len(distinct))
	}
}

// A command that cannot work has to say so and fail, not exit 0 with nothing done: an Agent
// reads the exit code to decide whether the evidence exists.
func TestTheCLIFailsLoudlyOnAnUnknownCommand(t *testing.T) {
	code, output := runCLIForTest(t, "--definitely-not-a-command")
	if code == 0 {
		t.Fatalf("an unknown command must not report success, output %q", output)
	}
	if !strings.Contains(output, "usage") && !strings.Contains(output, "unknown") {
		t.Fatalf("an unknown command explains itself, got %q", output)
	}
}

// A shell that runs graphcli from the checkout has no GRAPH_REPOSITORY set, and cannot be asked
// to set one: the tool has to find the repository itself, or the screenshot verb fails with
// "chdir app: no such file or directory" for everyone who runs it by hand.
func TestTheCLIFindsTheRepositoryWithoutBeingTold(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve the repository root: %v", err)
	}
	previous, hadPrevious := os.LookupEnv("GRAPH_REPOSITORY")
	if err := os.Unsetenv("GRAPH_REPOSITORY"); err != nil {
		t.Fatalf("unset: %v", err)
	}
	t.Cleanup(func() {
		if hadPrevious {
			_ = os.Setenv("GRAPH_REPOSITORY", previous)
		}
	})
	if found := RepositoryFromEnvironment(); found != root {
		t.Fatalf("the CLI finds the checkout it runs from, want %s got %q", root, found)
	}
}

// An Agent changing the interface has to be able to press it, not only photograph it. A
// screenshot proves a layout; it cannot prove that a click does what the label says. The verbs
// take a step script so the whole interaction is one call and one verdict:
//
//	steps: click "消息" | type "hello" | key cmd+v | frame | texts | has "欢迎" | shot out.png
func TestTheCLIDrivesTheInterfaceAndReportsWhatItSaw(t *testing.T) {
	root := cliSessionRoot(t)
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a CLI session: %v", err)
	}
	defer session.Close()

	shot := filepath.Join(root, "after.png")
	// Pressing a rail item is a real interaction: the label exists, and after the press the
	// page it names is the one showing. A screenshot alone could not tell a broken click from a
	// working one.
	output, err := session.Drive([]string{
		`has "轨迹"`,
		`click "轨迹"`,
		`frame`,
		`texts`,
		`shot ` + shot,
	})
	if err != nil {
		t.Fatalf("drive the interface: %v\n%s", err, output)
	}
	if !strings.Contains(output, "轨迹") {
		t.Fatalf("the page the rail item names has to be showing after the press, got:\n%s", output)
	}
	if info, statErr := os.Stat(shot); statErr != nil || info.Size() == 0 {
		t.Fatalf("the last step wrote its screenshot: %v", statErr)
	}
}

// A step that cannot be carried out must stop the run with the step and the reason, not walk on
// and report the later steps as if the earlier one had worked.
func TestTheCLIStopsAtAStepThatCannotBeCarriedOut(t *testing.T) {
	root := cliSessionRoot(t)
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a CLI session: %v", err)
	}
	defer session.Close()

	output, err := session.Drive([]string{
		`click "这个标签页不存在"`,
		`texts`,
	})
	if err == nil {
		t.Fatalf("a click on a label the interface does not show must fail, got:\n%s", output)
	}
	if !strings.Contains(err.Error(), "这个标签页不存在") {
		t.Fatalf("the failure names the step that could not be carried out, got %q", err)
	}
}
