package mygoauto

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	CallTimeout  = 15 * time.Second
	PollInterval = 200 * time.Millisecond
	StopGrace    = 5 * time.Second
)

type Session struct {
	opts      Options
	record    BuildRecord
	baseline  Baseline
	daemon    *exec.Cmd
	app       *exec.Cmd
	console   string
	token     string
	conn      *client
	window    int
	startedAt time.Time
}

func (s *Session) Build() BuildRecord       { return s.record }
func (s *Session) ConsoleURL() string       { return s.console }
func (s *Session) RunDir() string           { return s.opts.RunDir }
func (s *Session) SocketPath() string       { return s.opts.socketPath() }
func (s *Session) Window() int              { return s.window }
func (s *Session) StartedAt() time.Time     { return s.startedAt }
func (s *Session) Baseline() Baseline       { return s.baseline }
func (s *Session) Options() Options         { return s.opts }
func (s *Session) appLogPath() string       { return filepath.Join(s.opts.logsDir(), "app.log") }
func (s *Session) daemonLogPath() string    { return filepath.Join(s.opts.logsDir(), "daemon.log") }
func (s *Session) SessionTokenPath() string { return filepath.Join(s.opts.stateDir(), "session-token") }

type Status struct {
	RunDir     string    `json:"runDir"`
	ConsoleURL string    `json:"consoleUrl"`
	DaemonPID  int       `json:"daemonPid"`
	AppPID     int       `json:"appPid"`
	Window     int       `json:"window"`
	Socket     string    `json:"socket"`
	StartedAt  time.Time `json:"startedAt"`
	BuildSHA   string    `json:"buildSha256"`
}

func (s *Session) Status() Status {
	status := Status{
		RunDir: s.opts.RunDir, ConsoleURL: s.console, Window: s.window,
		Socket: s.opts.socketPath(), StartedAt: s.startedAt, BuildSHA: s.record.SHA256,
	}
	if s.daemon != nil && s.daemon.Process != nil {
		status.DaemonPID = s.daemon.Process.Pid
	}
	if s.app != nil && s.app.Process != nil {
		status.AppPID = s.app.Process.Pid
	}
	return status
}

// Launch builds the e2e app, starts an isolated daemon, then starts the app
// window attached to that daemon, and waits until the window answered with a
// settled accessibility tree.
func Launch(ctx context.Context, opts Options) (*Session, error) { return start(ctx, opts, true) }

// StartWindow does what Launch does without starting a daemon: the caller
// already has one (verify-graph launch), and the window attaches to it.
func StartWindow(ctx context.Context, opts Options) (*Session, error) { return start(ctx, opts, false) }

// Attach connects to the automation socket of a window this package started
// earlier, without starting or stopping anything.
func Attach(ctx context.Context, opts Options) (*Session, error) {
	opts = opts.withDefaults()
	session := &Session{opts: opts, startedAt: time.Now()}
	if err := session.attachSocket(); err != nil {
		return nil, err
	}
	if err := session.attachWindow(ctx); err != nil {
		_ = session.Close(ctx)
		return nil, err
	}
	return session, nil
}

func start(ctx context.Context, opts Options, withDaemon bool) (*Session, error) {
	opts = opts.withDefaults()
	if opts.RunDir == "" || opts.RepoRoot == "" {
		return nil, errors.New("mygoauto: RunDir and RepoRoot are required")
	}
	session := &Session{opts: opts, startedAt: time.Now(), baseline: opts.Baseline()}
	if err := prepare(opts); err != nil {
		return nil, err
	}
	record, err := session.buildOrReuse(ctx)
	if err != nil {
		return nil, err
	}
	session.record = record
	if withDaemon {
		if err := session.startDaemon(); err != nil {
			_ = session.Close(ctx)
			return nil, err
		}
		if err := session.waitDaemon(ctx); err != nil {
			_ = session.Close(ctx)
			return nil, err
		}
	} else if err := session.adoptDaemon(); err != nil {
		_ = session.Close(ctx)
		return nil, err
	}
	if err := session.startApp(); err != nil {
		_ = session.Close(ctx)
		return nil, err
	}
	if err := session.waitApp(ctx); err != nil {
		_ = session.Close(ctx)
		return nil, err
	}
	return session, nil
}

// buildOrReuse compiles the e2e app once per run directory. A rebuild while a
// window of the same run is alive is refused: the running app watches its own
// executable, execs itself when it changes, and the exec'd process cannot take
// the automation socket again, so every later command would hang.
func (s *Session) buildOrReuse(ctx context.Context) (BuildRecord, error) {
	binary := s.opts.appBinary()
	existing, err := os.Stat(binary)
	if err != nil || s.opts.ForceBuild {
		if record, err := ReadWindow(s.opts); err == nil && processAlive(record.AppPID) && s.opts.ForceBuild {
			return BuildRecord{}, fmt.Errorf("mygoauto: window pid %d of this run is still alive; run: verify-graph ui motion close, then rebuild", record.AppPID)
		}
		return Build(ctx, s.opts)
	}
	digest, err := fileSHA(binary)
	if err != nil {
		return BuildRecord{}, err
	}
	commit, dirty := gitState(s.opts.RepoRoot)
	return BuildRecord{
		Binary: binary, SHA256: digest, SizeBytes: existing.Size(), Tags: []string{"e2e"},
		MygoName: s.opts.appIdentityName(), MygoID: s.opts.appIdentityID(),
		SourceCommit: commit, SourceDirty: dirty, BuiltAt: existing.ModTime(),
	}, nil
}

func (s *Session) logFile(name string) (*os.File, error) {
	return os.OpenFile(filepath.Join(s.opts.logsDir(), name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

func (s *Session) startDaemon() error {
	log, err := s.logFile("daemon.log")
	if err != nil {
		return err
	}
	command := exec.Command(s.opts.appBinary(),
		"daemon",
		"--config", s.opts.configPath(),
		"--state-dir", s.opts.stateDir(),
		"--graph-home", s.opts.graphHome(),
		"--application-root", s.opts.SourceRoot,
		"--port", fmt.Sprintf("%d", s.opts.Port),
		"--view-only",
	)
	command.Env = s.opts.env(false)
	command.Stdout, command.Stderr = log, log
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		log.Close()
		return fmt.Errorf("mygoauto: cannot start the daemon: %w", err)
	}
	s.daemon = command
	go func() { _ = command.Wait(); log.Close() }()
	return nil
}

func (s *Session) readConsole() (string, bool) {
	payload, err := os.ReadFile(filepath.Join(s.opts.stateDir(), "console.json"))
	if err != nil {
		return "", false
	}
	var console struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(payload, &console) != nil || !strings.HasPrefix(console.URL, "http") {
		return "", false
	}
	return console.URL, true
}

func (s *Session) waitDaemon(ctx context.Context) error {
	deadline := time.Now().Add(s.opts.ReadyTimeout)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if url, ok := s.readConsole(); ok {
			if payload, err := s.health(url); err == nil && strings.Contains(string(payload), "ok") {
				s.console = url
				s.token = readToken(s.SessionTokenPath())
				return nil
			}
		}
		time.Sleep(PollInterval)
	}
	return fmt.Errorf("mygoauto: the daemon did not publish console.json within %s; read %s", s.opts.ReadyTimeout, s.daemonLogPath())
}

func (s *Session) health(url string) ([]byte, error) {
	request, err := http.NewRequest("GET", strings.TrimSuffix(url, "/")+"/api/health", nil)
	if err != nil {
		return nil, err
	}
	s.authorize(request)
	client := http.Client{Timeout: 2 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mygoauto: /api/health %d", response.StatusCode)
	}
	return io.ReadAll(response.Body)
}

func readToken(path string) string {
	payload, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(payload))
}

func (s *Session) authorize(request *http.Request) {
	if s.token != "" {
		request.Header.Set("Cookie", "graph_session="+s.token)
	}
}

// Get calls the daemon API as the app does: same loopback URL, same session
// cookie. It returns the body and the status code.
func (s *Session) Get(path string) (int, []byte, error) {
	if s.console == "" {
		return 0, nil, errors.New("mygoauto: the daemon is not up")
	}
	request, err := http.NewRequest("GET", strings.TrimSuffix(s.console, "/")+path, nil)
	if err != nil {
		return 0, nil, err
	}
	s.authorize(request)
	client := http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	return response.StatusCode, payload, err
}

func (s *Session) startApp() error {
	log, err := s.logFile("app.log")
	if err != nil {
		return err
	}
	command := exec.Command(s.opts.appBinary())
	command.Env = s.opts.env(true)
	command.Dir = s.opts.SourceRoot
	command.Stdout, command.Stderr = log, log
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		log.Close()
		return fmt.Errorf("mygoauto: cannot start the app window: %w", err)
	}
	s.app = command
	go func() { _ = command.Wait(); log.Close() }()
	return nil
}

// adoptDaemon points the session at the daemon a previous verify-graph launch
// started for the same run directory.
func (s *Session) adoptDaemon() error {
	if url, ok := s.readConsole(); ok {
		s.console = url
		s.token = readToken(s.SessionTokenPath())
		return nil
	}
	return fmt.Errorf("mygoauto: no daemon published %s; run: verify-graph launch --run %s",
		filepath.Join(s.opts.stateDir(), "console.json"), filepath.Base(s.opts.RunDir))
}

func (s *Session) attachSocket() error {
	deadline := time.Now().Add(s.opts.ReadyTimeout)
	for {
		if socketExists(s.opts.socketPath()) {
			if conn, err := dial(s.opts.socketPath(), 5*time.Second); err == nil {
				s.conn = conn
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("mygoauto: no window answers on %s; start one with: verify-graph ui motion open", s.opts.socketPath())
		}
		time.Sleep(PollInterval)
	}
}

func (s *Session) waitApp(ctx context.Context) error {
	if err := waitFor(ctx, s.opts.ReadyTimeout, "the automation socket "+s.opts.socketPath(), func() bool {
		return socketExists(s.opts.socketPath())
	}); err != nil {
		return fmt.Errorf("%w; read %s", err, s.appLogPath())
	}
	return s.attachWindow(ctx)
}

func (s *Session) attachWindow(ctx context.Context) error {
	var err error
	if s.conn == nil {
		if s.conn, err = dial(s.opts.socketPath(), 5*time.Second); err != nil {
			return err
		}
	}
	var windows []Window
	if err := waitFor(ctx, s.opts.ReadyTimeout, "a native window", func() bool {
		windows, err = s.conn.windows(CallTimeout)
		if err != nil {
			return false
		}
		for _, window := range windows {
			if window.Kind == "content" && window.Visible {
				s.window = window.ID
				return true
			}
		}
		return false
	}); err != nil {
		return err
	}
	return s.Idle(ctx, 20*time.Second)
}

func waitFor(ctx context.Context, timeout time.Duration, what string, ready func() bool) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if ready() {
			return nil
		}
		time.Sleep(PollInterval)
	}
	return fmt.Errorf("mygoauto: timed out after %s waiting for %s", timeout, what)
}

func (s *Session) Idle(ctx context.Context, timeout time.Duration) error {
	if s.conn == nil {
		return errors.New("mygoauto: the app is not attached")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.conn.idle(s.window, timeout)
}

func (s *Session) Windows() ([]Window, error) {
	if s.conn == nil {
		return nil, errors.New("mygoauto: the app is not attached")
	}
	return s.conn.windows(CallTimeout)
}

func (s *Session) Tree(ctx context.Context) (Tree, error) {
	if s.conn == nil {
		return nil, errors.New("mygoauto: the app is not attached")
	}
	nodes, err := s.conn.tree(s.window, CallTimeout)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return Tree(nodes), nil
}

func (s *Session) Resolve(sel Sel) (Node, error) {
	tree, err := s.Tree(context.Background())
	if err != nil {
		return Node{}, err
	}
	return tree.Find(sel)
}

func (s *Session) Act(ctx context.Context, id, action, text string) error {
	if s.conn == nil {
		return errors.New("mygoauto: the app is not attached")
	}
	if err := s.conn.act(s.window, id, action, text, CallTimeout); err != nil {
		return err
	}
	return s.Idle(ctx, 10*time.Second)
}

// Press resolves the selector in the current tree and presses it.
func (s *Session) Press(ctx context.Context, sel Sel) (Node, error) {
	node, err := s.Resolve(sel)
	if err != nil {
		return Node{}, err
	}
	return node, s.Act(ctx, node.ID, "press", "")
}
