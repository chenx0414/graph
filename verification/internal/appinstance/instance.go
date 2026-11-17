package appinstance

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Options struct {
	Repo            string
	Root            string
	Mode            string
	AppBinary       string
	DaemonBinary    string
	DesktopBin      string
	StateDirPath    string
	HomeDirPath     string
	TmpDirPath      string
	ConfigFile      string
	EvidenceDirPath string
	SkipPrepare     bool
}

type instanceRecord struct {
	Root       string `json:"root"`
	AppPID     int    `json:"appPid,omitempty"`
	DaemonPID  int    `json:"daemonPid,omitempty"`
	Mode       string `json:"mode"`
	URL        string `json:"url,omitempty"`
	AppBinary  string `json:"appBinary"`
	AppName    string `json:"appName"`
	ConfigPath string `json:"configPath"`
	StartedAt  string `json:"startedAt,omitempty"`
}

type Instance struct {
	Options
	AppPID    int
	DaemonPID int
	URL       string
	StartedAt string
	AppName   string
	desktop   *Desktop
	record    instanceRecord
}

func NewSuffix() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(buffer)
}

func New(options Options) (*Instance, error) {
	if options.Repo == "" {
		return nil, fmt.Errorf("repo root is required")
	}
	if options.Root == "" {
		return nil, fmt.Errorf("run root is required")
	}
	if options.Mode == "" {
		options.Mode = "view"
	}
	if options.Mode != "view" && options.Mode != "execute" {
		return nil, fmt.Errorf("mode must be view or execute, got %q", options.Mode)
	}
	if options.AppBinary == "" {
		options.AppBinary = filepath.Join(options.Repo, "dist", "app", "mac-arm64", "Graph.app", "Contents", "MacOS", "Graph")
	}
	instance := &Instance{Options: options}
	instance.AppName = "GraphVerify-" + filepath.Base(options.Root)
	instance.desktop = NewDesktop(instance.AppName)
	if options.DesktopBin != "" {
		instance.desktop.Bin = options.DesktopBin
	}
	return instance, nil
}

func (i *Instance) prepare() error {
	for _, dir := range []string{
		i.BinDir(), i.HomeDir(), i.StateDir(), i.GraphHome(), i.ProjectRoot(),
		i.TmpDir(), i.RunDir(), i.ShimDir(), i.LogsDir(), i.EvidenceDir(),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := os.Chmod(i.StateDir(), 0o700); err != nil {
		return err
	}
	if err := i.writeBinary(); err != nil {
		return err
	}
	if err := i.writeShim(); err != nil {
		return err
	}
	if i.Options.ConfigFile == "" {
		if err := i.writeConfig(); err != nil {
			return err
		}
	}
	return i.Save()
}

func (i *Instance) writeBinary() error {
	if i.DaemonBinary != "" {
		if err := copyFile(i.DaemonBinary, filepath.Join(i.BinDir(), "graphd")); err != nil {
			return err
		}
	}
	info, err := os.Stat(i.AppBinary)
	if err != nil {
		return fmt.Errorf("app binary not found at %s (build it with: go -C backend run ./cmd/graphbuild app): %w", i.AppBinary, err)
	}
	if info.IsDir() {
		return fmt.Errorf("app binary path is a directory: %s", i.AppBinary)
	}
	return copyFile(i.AppBinary, i.AppPath())
}

func (i *Instance) WriteShim() (string, error) {
	shim := "#!/bin/sh\necho \"verify-graph launchctl shim: refusing $*\" >&2\nexit 1\n"
	path := filepath.Join(i.ShimDir(), "launchctl")
	if err := os.WriteFile(path, []byte(shim), 0o755); err != nil {
		return "", err
	}
	return path, os.Chmod(path, 0o755)
}

func (i *Instance) writeShim() error {
	_, err := i.WriteShim()
	return err
}

func (i *Instance) writeConfig() error {
	document := map[string]any{
		"version":  1,
		"projects": []map[string]string{{"id": "verify", "root": i.ProjectRoot()}},
	}
	payload, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(i.ConfigPath(), append(payload, '\n'), 0o644)
}

func (i *Instance) Save() error {
	record := instanceRecord{
		Root:       i.Options.Root,
		AppPID:     i.AppPID,
		DaemonPID:  i.DaemonPID,
		Mode:       i.Mode,
		URL:        i.URL,
		AppBinary:  i.AppPath(),
		AppName:    i.AppName,
		ConfigPath: i.ConfigPath(),
		StartedAt:  i.StartedAt,
	}
	payload, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	i.record = record
	return os.WriteFile(i.RecordPath(), append(payload, '\n'), 0o644)
}

func Load(root string) (*Instance, error) {
	payload, err := os.ReadFile(filepath.Join(root, "instance.json"))
	if err != nil {
		return nil, fmt.Errorf("no instance record in %s: %w", root, err)
	}
	var record instanceRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return nil, fmt.Errorf("%s/instance.json is not valid JSON: %w", root, err)
	}
	instance := &Instance{
		Options: Options{
			Root:      record.Root,
			Mode:      record.Mode,
			AppBinary: record.AppBinary,
		},
		record: record,
	}
	instance.AppPID = record.AppPID
	instance.DaemonPID = record.DaemonPID
	instance.URL = record.URL
	instance.AppName = record.AppName
	instance.desktop = NewDesktop(record.AppName)
	return instance, nil
}

func (i *Instance) RunRoot() string { return i.Options.Root }
func (i *Instance) BinDir() string  { return filepath.Join(i.Options.Root, "bin") }
func (i *Instance) HomeDir() string {
	if i.Options.HomeDirPath != "" {
		return i.Options.HomeDirPath
	}
	return filepath.Join(i.Options.Root, "home")
}
func (i *Instance) InstanceDir() string { return filepath.Join(i.Options.Root, "instance") }
func (i *Instance) StateDir() string {
	if i.Options.StateDirPath != "" {
		return i.Options.StateDirPath
	}
	return filepath.Join(i.InstanceDir(), "state")
}
func (i *Instance) GraphHome() string { return filepath.Join(i.Options.Root, "graph-home") }
func (i *Instance) ConfigPath() string {
	if i.Options.ConfigFile != "" {
		return i.Options.ConfigFile
	}
	return filepath.Join(i.Options.Root, "graph.config.json")
}
func (i *Instance) ProjectRoot() string { return filepath.Join(i.Options.Root, "project") }
func (i *Instance) TmpDir() string {
	if i.Options.TmpDirPath != "" {
		return i.Options.TmpDirPath
	}
	return filepath.Join(i.Options.Root, "tmp")
}
func (i *Instance) RunDir() string  { return filepath.Join(i.Options.Root, "run") }
func (i *Instance) ShimDir() string { return filepath.Join(i.Options.Root, "shim") }
func (i *Instance) LogsDir() string { return filepath.Join(i.Options.Root, "logs") }
func (i *Instance) EvidenceDir() string {
	if i.Options.EvidenceDirPath != "" {
		return i.Options.EvidenceDirPath
	}
	return filepath.Join(i.Options.Root, "evidence")
}
func (i *Instance) AppPath() string         { return filepath.Join(i.BinDir(), "Graph") }
func (i *Instance) RecordPath() string      { return filepath.Join(i.Options.Root, "instance.json") }
func (i *Instance) ConsolePath() string     { return filepath.Join(i.StateDir(), "console.json") }
func (i *Instance) TokenPath() string       { return filepath.Join(i.StateDir(), "session-token") }
func (i *Instance) WhiteboardPath() string  { return filepath.Join(i.StateDir(), "whiteboard.json") }
func (i *Instance) AppLog() string          { return filepath.Join(i.LogsDir(), "app.log") }
func (i *Instance) DaemonLog() string       { return filepath.Join(i.LogsDir(), "daemon.log") }
func (i *Instance) DesktopClient() *Desktop { return i.desktop }

func (i *Instance) Environment() []string {
	path := strings.Join([]string{i.ShimDir(), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"}, ":")
	return []string{
		"HOME=" + i.HomeDir(),
		"TMPDIR=" + i.TmpDir(),
		"XDG_RUNTIME_DIR=" + i.RunDir(),
		"PATH=" + path,
		"GRAPH_STATE_DIR=" + i.StateDir(),
		"GRAPH_HOME=" + i.GraphHome(),
		"GRAPH_CONFIG=" + i.ConfigPath(),
		"GRAPH_DAEMON=" + i.AppPath(),
		"GRAPH_RSI_ROOT=" + i.Repo,
	}
}

func (i *Instance) envForChild() []string {
	base := []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "GRAPH_") {
			continue
		}
		base = append(base, entry)
	}
	return append(base, i.Environment()...)
}

func copyFile(source, target string) error {
	payload, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.WriteFile(target, payload, 0o755); err != nil {
		return err
	}
	return os.Chmod(target, 0o755)
}

func FileDigest(path string) string {
	payload, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func (i *Instance) Evidence(name string) string {
	return filepath.Join(i.EvidenceDir(), name)
}

type Artifact struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

func (i *Instance) WriteEvidence(name string, payload []byte) (Artifact, error) {
	path := i.Evidence(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return Artifact{}, err
	}
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		return Artifact{}, err
	}
	return artifact(path), nil
}

func artifact(path string) Artifact {
	info, _ := os.Stat(path)
	kind := "json"
	switch {
	case strings.HasSuffix(path, ".png"):
		kind = "screenshot"
	case strings.HasSuffix(path, ".log"):
		kind = "log"
	}
	size := int64(0)
	if info != nil {
		size = info.Size()
	}
	return Artifact{Kind: kind, Path: path, SHA256: FileDigest(path), Bytes: size}
}
