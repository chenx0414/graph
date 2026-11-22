package harness

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The whole loop an Agent runs: start an app, create a conversation, send, read it back, take a
// screenshot - all through the CLI binary, the way a shell script would.
func TestTheCLIRunsTheWholeVerificationLoop(t *testing.T) {
	root := t.TempDir()
	session, err := StartCLISession(CLISessionOptions{Repository: repositoryForTest(t), Root: root})
	if err != nil {
		t.Fatalf("start a session: %v", err)
	}
	defer session.Close()

	ran := func(args ...string) string {
		t.Helper()
		command := exec.Command("go", append([]string{
			"-C", filepath.Join(repositoryForTest(t), "backend"), "run", "./cmd/graphcli",
		}, args...)...)
		command.Env = append(os.Environ(), "GRAPH_REPOSITORY="+repositoryForTest(t))
		out, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("graphcli %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}

	// 1. the app answers
	if out := ran("health", "--address", session.URL(), "--token", session.token); !strings.Contains(out, "healthy") {
		t.Fatalf("health: %s", out)
	}
	// 2. a conversation exists, with its first message
	opened := ran("open", "--address", session.URL(), "--token", session.token,
		"--title", "e2e", "--text", "第一条")
	conversationID := jsonStringField(t, opened, "id")
	// 3. a second message through the CLI
	sent := ran("send", "--address", session.URL(), "--token", session.token,
		"--conversation", conversationID, "--text", "第二条")
	messageID := jsonStringField(t, sent, "id")
	// 4. reading it back proves it was stored
	read := ran("read", "--address", session.URL(), "--token", session.token, "--conversation", conversationID)
	if !strings.Contains(read, messageID) {
		t.Fatalf("the message the CLI sent is not in the conversation it read: %s", read)
	}
	if !strings.Contains(read, "第二条") {
		t.Fatalf("the message text survived the round trip: %s", read)
	}
	// 5. evidence
	shot := filepath.Join(root, "proof.png")
	ran("shot", "--address", session.URL(), "--token", session.token, "--out", shot)
	if len(mustReadFile(t, shot)) == 0 {
		t.Fatalf("the screenshot is empty")
	}
}
