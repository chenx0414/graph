package main

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// The message the user saw on the whiteboard panel, copied from the screenshot: a loopback URL
// and a Go transport word, which says nothing a person can act on and looks like the console
// itself is broken. It appears during a reload, on several surfaces at once.
const rawTransportMessage = `Get "http://127.0.0.1:57970/api/conversations/ebd518f3-312f-4f8c-bf8b-7d34f77d3151/trajectory": EOF`

func transportError() error { return errors.New(rawTransportMessage) }

// Every read a person can see must say what happened in words they can use, not print the URL
// and the transport word. readFailureText is the one place that decides this wording, so a read
// that composes its own sentence drifts away from it - which is how the trajectory panel came to
// show the raw error while the fleet cards had already been fixed.
func TestReadFailureTextHidesTheURLAndTheTransportWord(t *testing.T) {
	for _, subject := range []string{"轨迹", "Graph 拓扑", "会话列表", "运行信息", "资源库"} {
		text := readFailureText(transportError(), subject)
		for _, forbidden := range []string{"http://", "127.0.0.1", "EOF", "Get "} {
			if strings.Contains(text, forbidden) {
				t.Fatalf("a read failure shown for %s must not contain %q, got %q", subject, forbidden, text)
			}
		}
		if !strings.Contains(text, subject) {
			t.Fatalf("the failure must name what could not be read (%s), got %q", subject, text)
		}
	}
}

// Every transient transport error ends up in the same sentence, so the user learns one thing:
// this is a connection that will come back, not a broken panel.
func TestReadFailureTextSaysItWillRetryForEveryTransientShape(t *testing.T) {
	for _, message := range []string{
		rawTransportMessage,
		`Get "http://127.0.0.1:57970/api/x": dial tcp 127.0.0.1:57970: connect: connection refused`,
		"wsarecv: An existing connection was forcibly closed by the remote host.",
		"unexpected EOF",
		`Get "http://127.0.0.1:57970/api/x": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
	} {
		text := readFailureText(errors.New(message), "轨迹")
		if !strings.Contains(text, "正在重试") {
			t.Fatalf("a transient transport failure must say it is retrying, got %q for %q", text, message)
		}
	}
}

// A failure that is not the transport still has to name its subject, and must not pretend to be
// retrying: a 404 for a deleted conversation is not a connection problem.
func TestReadFailureTextDoesNotCallEveryFailureTransient(t *testing.T) {
	text := readFailureText(errors.New("unexpected status 404"), "轨迹")
	if strings.Contains(text, "正在重试") {
		t.Fatalf("a non-transient failure must not promise a retry, got %q", text)
	}
	if !strings.Contains(text, "轨迹") {
		t.Fatalf("a non-transient failure still names what it could not read, got %q", text)
	}
}

// A nil error has no sentence: callers rely on that to mean "no failure".
func TestReadFailureTextOfNoErrorIsEmpty(t *testing.T) {
	if text := readFailureText(nil, "轨迹"); text != "" {
		t.Fatalf("no error is no sentence, got %q", text)
	}
}

// The contract that keeps this from regressing one surface at a time: no file in the app may
// build a user-facing read failure out of err.Error(). It is checked against the source rather
// than a list of call sites, so a new surface cannot quietly reintroduce the raw text.
func TestNoUserFacingReadFailurePrintsTheRawError(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("list the app sources: %v", err)
	}
	fset := token.NewFileSet()
	offenders := []string{}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		parsed, err := parser.ParseFile(fset, file, source, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			binary, ok := node.(*ast.BinaryExpr)
			if !ok || binary.Op != token.ADD {
				return true
			}
			left, ok := binary.X.(*ast.BasicLit)
			if !ok || left.Kind != token.STRING {
				return true
			}
			prefix, err := strconv.Unquote(left.Value)
			if err != nil || !strings.Contains(prefix, "读不到") {
				return true
			}
			// The failure text itself is allowed to be built from err.Error(); it is the one
			// place that reads it, and it never hands the raw message on.
			if call, ok := binary.Y.(*ast.CallExpr); ok {
				if selector, ok := call.Fun.(*ast.SelectorExpr); ok {
					if ident, ok := selector.X.(*ast.Ident); ok && ident.Name == "err" {
						offenders = append(offenders, fset.Position(node.Pos()).String()+
							": 读不到…拼接原始 err.Error()，请改用 readFailureText(err, subject)")
					}
				}
			}
			return true
		})
	}
	if len(offenders) > 0 {
		t.Fatalf("a user-facing read failure prints the raw transport error:\n%s", strings.Join(offenders, "\n"))
	}
}

// The panel the user circled shows state.failed as its own text, so the wording has to be right
// where a person reads it - not only inside the helper. This drives a real transport failure
// through the loader the panel uses and asserts what the panel renders.
func TestTheTrajectoryPanelNeverShowsTheRawTransportError(t *testing.T) {
	// A daemon that refuses the connection is what a reload looks like from the app's side.
	server := blankServerThatClosesImmediately(t)
	defer server.Close()
	shell := &shellState{api: newAPIClient(server.URL, "")}
	shell.trajectory.scopeKey = shell.chatScope().key()
	shell.startTrajectory("/api/conversations/c1/trajectory", false)
	waitForTrajectoryFailure(t, shell)

	failed := shell.trajectory.failed
	if failed == "" {
		t.Fatalf("the panel records that its read failed")
	}
	for _, forbidden := range []string{"http://", "127.0.0.1", "EOF", "Get "} {
		if strings.Contains(failed, forbidden) {
			t.Fatalf("the panel must not show %q to a person, got %q", forbidden, failed)
		}
	}
	if !strings.Contains(failed, "轨迹") {
		t.Fatalf("the panel names what it could not read, got %q", failed)
	}

	tester := newTester(func(ctx *ui.Context) { shell.panelTrajectory(ctx) }, 900, 600)
	frames(tester)
	for _, text := range tester.Texts() {
		for _, forbidden := range []string{"http://", "127.0.0.1", "EOF"} {
			if strings.Contains(text, forbidden) {
				t.Fatalf("the rendered panel shows %q, texts %q", forbidden, tester.Texts())
			}
		}
	}
}

// blankServerThatClosesImmediately answers every request by dropping the connection, which is
// what the daemon does mid-reload and what produced the EOF in the screenshot.
func blankServerThatClosesImmediately(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				conn.Close()
				return
			}
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	_ = net.Dial
	return server
}

// waitForTrajectoryFailure waits until the loader has settled, so the assertion reads a result
// rather than racing the goroutine that produces it.
func waitForTrajectoryFailure(t *testing.T, shell *shellState) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if shell.trajectory.failed != "" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the trajectory load never settled on a failure")
}
