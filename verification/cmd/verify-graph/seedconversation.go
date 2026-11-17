package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// seedPrompt is the journey-level fixture: before the UI steps run, a real
// project conversation is created through the daemon API and one message is
// dispatched to the stub model. That is the only way a rendering journey can
// assert user-visible text without touching the user's own state or spending
// real quota. `expect` pins the assistant answer the stub is configured to
// give, so a journey cannot silently accept a different transcript.
type seedPrompt struct {
	Prompt    string `json:"prompt"`
	Expect    string `json:"expect,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
}

type seedOutcome struct {
	ProjectID      string `json:"projectId"`
	ConversationID string `json:"conversationId"`
	TaskID         string `json:"taskId"`
	AssistantText  string `json:"assistantText"`
	Messages       int    `json:"messages"`
	InputTokens    int    `json:"inputTokens"`
	OutputTokens   int    `json:"outputTokens"`
	ElapsedMs      int64  `json:"elapsedMs"`
	Turns          int    `json:"turns"`
}

type apiConsole struct {
	client *apiClient
}

func (c apiConsole) Post(path string, body, out any) error {
	status, payload, err := c.client.do("POST", path, body)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("POST %s -> %d: %s", path, status, truncate(string(payload), 300))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("POST %s answered with invalid JSON: %w", path, err)
	}
	return nil
}

func (c apiConsole) JSON(path string, out any) error {
	status, payload, err := c.client.do("GET", path, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("GET %s -> %d: %s", path, status, truncate(string(payload), 300))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("GET %s answered with invalid JSON: %w", path, err)
	}
	return nil
}

type conversationReadback struct {
	Cursor   int `json:"cursor"`
	Messages []struct {
		Role  string `json:"role"`
		Text  string `json:"text"`
		State string `json:"state"`
	} `json:"messages"`
}

type trajectoryReadback struct {
	Turns  []map[string]any `json:"turns"`
	Totals struct {
		Input  int `json:"input"`
		Output int `json:"output"`
	} `json:"totals"`
}

// seedConversation drives the same two calls the window makes: open the
// project thread, then send one message. It polls the transcript (product
// state, with a deadline) instead of sleeping a fixed time, so a slow machine
// cannot turn this into a flaky assertion.
func seedConversation(meta runMeta, spec seedPrompt) (seedOutcome, error) {
	console := apiConsole{client: newAPIClient(meta.Daemon.URL, readToken(meta.StateDir))}
	projectID := firstNonEmpty(spec.ProjectID, "verify")
	requestID := firstNonEmpty(spec.RequestID, "vg-seed")
	outcome := seedOutcome{ProjectID: projectID}
	var thread struct {
		ConversationID string `json:"conversationId"`
		TaskID         string `json:"taskId"`
		Role           string `json:"role"`
	}
	if err := console.Post("/api/projects/"+projectID+"/thread", map[string]any{"requestId": requestID + "-thread"}, &thread); err != nil {
		return outcome, err
	}
	if thread.ConversationID == "" {
		return outcome, fmt.Errorf("POST /api/projects/%s/thread created no conversation", projectID)
	}
	outcome.ConversationID = thread.ConversationID
	outcome.TaskID = thread.TaskID
	var sent struct {
		MessageID string `json:"messageId"`
		State     string `json:"state"`
	}
	if err := console.Post("/api/conversations/"+thread.ConversationID+"/messages",
		map[string]any{"text": spec.Prompt, "requestId": requestID + "-message"}, &sent); err != nil {
		return outcome, err
	}
	if sent.MessageID == "" {
		return outcome, fmt.Errorf("POST /api/conversations/%s/messages accepted no message", thread.ConversationID)
	}
	started := time.Now()
	deadline := started.Add(120 * time.Second)
	for {
		var conversation conversationReadback
		if err := console.JSON("/api/conversations/"+thread.ConversationID, &conversation); err != nil {
			return outcome, err
		}
		outcome.Messages = len(conversation.Messages)
		outcome.AssistantText = ""
		for _, message := range conversation.Messages {
			if message.Role == "assistant" && strings.TrimSpace(message.Text) != "" {
				outcome.AssistantText = message.Text
			}
		}
		if outcome.AssistantText != "" {
			break
		}
		if !time.Now().Before(deadline) {
			return outcome, fmt.Errorf("the seeded turn produced no assistant message within 120s; transcript: %s", describeRoles(conversation.Messages))
		}
		time.Sleep(150 * time.Millisecond)
	}
	outcome.ElapsedMs = time.Since(started).Milliseconds()
	var trajectory trajectoryReadback
	if err := console.JSON("/api/conversations/"+thread.ConversationID+"/trajectory", &trajectory); err != nil {
		return outcome, err
	}
	outcome.Turns = len(trajectory.Turns)
	outcome.InputTokens = trajectory.Totals.Input
	outcome.OutputTokens = trajectory.Totals.Output
	if spec.Expect != "" && outcome.AssistantText != spec.Expect {
		return outcome, fmt.Errorf("the stub answered %q, the journey expects %q", outcome.AssistantText, spec.Expect)
	}
	return outcome, nil
}

func describeRoles(messages []struct {
	Role  string `json:"role"`
	Text  string `json:"text"`
	State string `json:"state"`
}) string {
	parts := []string{}
	for _, message := range messages {
		parts = append(parts, message.Role+"/"+message.State)
	}
	return strings.Join(parts, ", ")
}

func seedAssertion(outcome seedOutcome, spec seedPrompt, evidencePath string) assertion {
	record := assertion{
		ID:       "seed.conversation",
		Expected: "one project conversation whose assistant turn completed with tokens: " + truncate(spec.Prompt, 80),
		Evidence: evidencePath,
	}
	if outcome.AssistantText == "" {
		record.Actual = "the seeded conversation produced no assistant text"
		return record
	}
	record.OK = outcome.OutputTokens > 0 && outcome.Messages >= 2
	record.Actual = fmt.Sprintf("conversation=%s messages=%d turns=%d tokens=%d/%d elapsed=%dms assistant=%q",
		outcome.ConversationID, outcome.Messages, outcome.Turns,
		outcome.InputTokens, outcome.OutputTokens, outcome.ElapsedMs, truncate(outcome.AssistantText, 120))
	return record
}

func writeSeedEvidence(outDir string, outcome seedOutcome, spec seedPrompt, err error) (string, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", err
	}
	payload := map[string]any{"prompt": spec, "outcome": outcome}
	if err != nil {
		payload["error"] = err.Error()
	}
	raw, marshalErr := json.MarshalIndent(payload, "", "  ")
	if marshalErr != nil {
		return "", marshalErr
	}
	path := filepath.Join(outDir, "seed.json")
	if writeErr := os.WriteFile(path, append(raw, '\n'), 0o644); writeErr != nil {
		return "", writeErr
	}
	return path, nil
}
