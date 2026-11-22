package harness

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type CLISessionOptions struct {
	Repository string
	Root string
	Mode string
}

func NewCLISession(address, token string) *CLISession {
	return &CLISession{daemon: &Daemon{URL: address}, token: token, repository: RepositoryFromEnvironment()}
}

func RepositoryFromEnvironment() string {
	if set := os.Getenv("GRAPH_REPOSITORY"); set != "" {
		return set
	}
	candidate, err := os.Executable()
	if err != nil {
		return ""
	}
	directory := filepath.Dir(candidate)
	for depth := 0; depth < 6; depth++ {
		if _, err := os.Stat(filepath.Join(directory, "app", "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(directory, "backend", "go.mod")); err == nil {
				return directory
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return ""
		}
		directory = parent
	}
	return ""
}

type CLISession struct {
	daemon     *Daemon
	root       string
	token      string
	repository string
}

func StartCLISession(options CLISessionOptions) (*CLISession, error) {
	if options.Repository == "" {
		return nil, fmt.Errorf("a CLI session needs a repository to run")
	}
	if options.Root == "" {
		return nil, fmt.Errorf("a CLI session needs a root directory for its state")
	}
	daemon, err := StartDaemon(DaemonOptions{
		Repository: options.Repository,
		Root:       options.Root,
		Mode:       options.Mode,
	})
	if err != nil {
		return nil, err
	}
	session := &CLISession{daemon: daemon, root: options.Root, repository: options.Repository}
	token, err := session.readToken()
	if err != nil {
		daemon.Close()
		return nil, err
	}
	session.token = token
	return session, nil
}

func (session *CLISession) readToken() (string, error) {
	stateDir := filepath.Join(session.root, "state")
	for _, name := range []string{"session-token", "app-token"} {
		path := filepath.Join(stateDir, name)
		body, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if token := strings.TrimSpace(string(body)); token != "" {
			return token, nil
		}
	}
	return "", fmt.Errorf("the daemon did not write a session token in %s", stateDir)
}

func (session *CLISession) URL() string { return session.daemon.URL }

func (session *CLISession) Close() { session.daemon.Close() }

type CLIConversation struct {
	ID string `json:"id"`
}

type CLIMessage struct {
	ID string `json:"id"`
}

type CLITranscript struct {
	Messages []struct {
		ID   string `json:"id"`
		Role string `json:"role"`
		Text string `json:"text"`
	} `json:"messages"`
}

func (session *CLISession) Healthy() (bool, error) {
	body, status, err := session.request("GET", "/api/health", nil)
	if err != nil {
		return false, err
	}
	return status == 200 && len(body) > 0, nil
}

func (session *CLISession) CreateConversation(title, firstMessage string) (CLIConversation, error) {
	body, status, err := session.request("POST", "/api/conversations", map[string]any{
		"title": title, "text": firstMessage, "requestId": "cli-create-" + title,
	})
	if err != nil {
		return CLIConversation{}, err
	}
	if status != 200 {
		return CLIConversation{}, fmt.Errorf("create conversation: the app answered %d: %s", status, body)
	}
	var created CLIConversation
	if err := json.Unmarshal(body, &created); err != nil {
		return CLIConversation{}, fmt.Errorf("create conversation: %w", err)
	}
	if created.ID == "" {
		var any map[string]any
		if err := json.Unmarshal(body, &any); err == nil {
			for _, key := range []string{"id", "conversationId"} {
				if value, ok := any[key].(string); ok && value != "" {
					created.ID = value
				}
			}
		}
	}
	if created.ID == "" {
		return CLIConversation{}, fmt.Errorf("create conversation: the app answered without an id: %s", body)
	}
	return created, nil
}

func (session *CLISession) SendMessage(conversationID, text string) (CLIMessage, error) {
	body, status, err := session.request("POST", "/api/conversations/"+conversationID+"/messages", map[string]any{
		"text": text, "requestId": "cli-" + conversationID + "-" + fmt.Sprint(len(text)),
	})
	if err != nil {
		return CLIMessage{}, err
	}
	if status != 200 {
		return CLIMessage{}, fmt.Errorf("send message: the app answered %d: %s", status, body)
	}
	var sent map[string]any
	if err := json.Unmarshal(body, &sent); err != nil {
		return CLIMessage{}, fmt.Errorf("send message: %w", err)
	}
	id, _ := sent["messageId"].(string)
	if id == "" {
		id, _ = sent["id"].(string)
	}
	if id == "" {
		return CLIMessage{}, fmt.Errorf("send message: the app answered without a message id: %s", body)
	}
	return CLIMessage{ID: id}, nil
}

func (session *CLISession) ReadConversation(conversationID string) (CLITranscript, error) {
	body, status, err := session.request("GET", "/api/conversations/"+conversationID, nil)
	if err != nil {
		return CLITranscript{}, err
	}
	if status != 200 {
		return CLITranscript{}, fmt.Errorf("read conversation: the app answered %d: %s", status, body)
	}
	var transcript CLITranscript
	if err := json.Unmarshal(body, &transcript); err != nil {
		return CLITranscript{}, fmt.Errorf("read conversation: %w", err)
	}
	return transcript, nil
}

func (session *CLISession) request(method, path string, payload map[string]any) ([]byte, int, error) {
	var reader *bytes.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	return doAppRequest(method, session.URL(), path, session.token, reader)
}

func doAppRequest(method, base, path, token string, body *bytes.Reader) ([]byte, int, error) {
	request, err := http.NewRequest(method, strings.TrimSuffix(base, "/")+path, body)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Cookie", "graph_session="+token)
	request.Header.Set("Origin", base)
	if body != nil && method != http.MethodGet {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return answer, response.StatusCode, nil
}

func (session *CLISession) Screenshot(output string, size ...int) error {
	binary, err := session.appBinary()
	if err != nil {
		return err
	}
	arguments := []string{"screenshot",
		"--address", session.URL(), "--token", session.token, "--out", output}
	if len(size) >= 2 {
		arguments = append(arguments, "--width", fmt.Sprint(size[0]), "--height", fmt.Sprint(size[1]))
	}
	command := exec.Command(binary, arguments...)
	var logs bytes.Buffer
	command.Stdout = &logs
	command.Stderr = &logs
	if err := command.Run(); err != nil {
		return fmt.Errorf("screenshot: %v: %s", err, logs.String())
	}
	if info, err := os.Stat(output); err != nil || info.Size() == 0 {
		return fmt.Errorf("screenshot: nothing was written to %s", output)
	}
	return nil
}

func appBinaryIsStale(repository, binary string) bool {
	built, err := os.Stat(binary)
	if err != nil {
		return true
	}
	stale := false
	walkErr := filepath.WalkDir(filepath.Join(repository, "app"), func(path string, entry os.DirEntry, incoming error) error {
		if incoming != nil || stale {
			return incoming
		}
		if entry.IsDir() {
			if name := entry.Name(); name == "build" || name == "dist" || name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" && filepath.Base(path) != "go.mod" && filepath.Base(path) != "go.sum" {
			return nil
		}
		if info, statErr := entry.Info(); statErr == nil && info.ModTime().After(built.ModTime()) {
			stale = true
		}
		return nil
	})
	if walkErr != nil {
		return true
	}
	return stale
}

func (session *CLISession) appBinary() (string, error) {
	repository := filepath.Join(session.root, "..")
	_ = repository
	binary := filepath.Join(session.repository, "dist", "graphapp")
	if _, err := os.Stat(binary); err == nil && !appBinaryIsStale(session.repository, binary) {
		return binary, nil
	}
	build := exec.Command("go", "-C", filepath.Join(session.repository, "app"), "build", "-o", binary, ".")
	build.Stdout = os.Stderr
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return "", fmt.Errorf("build the app binary for the screenshot verb: %w", err)
	}
	return binary, nil
}
