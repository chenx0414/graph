package seed

import (
	"errors"
	"time"
)

type Console interface {
	Post(path string, body, out any) error
	JSON(path string, out any) error
}

type Options struct {
	ProjectID string
	Model     string
	Prompt    string
	RequestID string
	Timeout   time.Duration
	Poll      time.Duration
	Now       func() time.Time
	Sleep     func(time.Duration)
}

type Operation struct {
	ID             string `json:"id"`
	State          string `json:"state"`
	WorkerActive   bool   `json:"workerActive"`
	ConversationID string `json:"conversationId,omitempty"`
}

type Created struct {
	ConversationID string `json:"conversationId"`
	TaskID         string `json:"taskId"`
}

type Result struct {
	ProjectID      string      `json:"projectId"`
	ConversationID string      `json:"conversationId"`
	TaskID         string      `json:"taskId"`
	Operations     []Operation `json:"operations"`
	Completed      bool        `json:"completed"`
	Succeeded      bool        `json:"succeeded"`
	ElapsedMs      int64       `json:"elapsedMs"`
}

var ErrTimeout = errors.New("seed: operations did not settle before the deadline")

func (o Options) defaults() Options {
	if o.ProjectID == "" {
		o.ProjectID = "verify"
	}
	if o.Model == "" {
		o.Model = "seed"
	}
	if o.Prompt == "" {
		o.Prompt = "用一句话说明你已就绪。"
	}
	if o.RequestID == "" {
		o.RequestID = "seed-" + time.Now().UTC().Format("20060102T150405")
	}
	if o.Timeout <= 0 {
		o.Timeout = 180 * time.Second
	}
	if o.Poll <= 0 {
		o.Poll = 500 * time.Millisecond
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = time.Sleep
	}
	return o
}

func Seed(console Console, options Options) (Result, error) {
	o := options.defaults()
	started := o.Now()
	var created Created
	err := console.Post("/api/conversations", map[string]any{
		"projectId": o.ProjectID,
		"model":     o.Model,
		"text":      o.Prompt,
		"requestId": o.RequestID,
	}, &created)
	if err != nil {
		return Result{ProjectID: o.ProjectID}, err
	}
	result := Result{ProjectID: o.ProjectID, ConversationID: created.ConversationID, TaskID: created.TaskID}
	if created.ConversationID == "" {
		return result, errors.New("seed: the console created no conversation")
	}
	deadline := started.Add(o.Timeout)
	for {
		var operations []Operation
		if err := console.JSON("/api/tasks/"+created.TaskID+"/operations?latest=true", &operations); err != nil {
			return result, err
		}
		result.Operations = operations
		if settled(operations) {
			result.Completed = true
			result.Succeeded = allSucceeded(operations)
			result.ElapsedMs = o.Now().Sub(started).Milliseconds()
			return result, nil
		}
		if !o.Now().Before(deadline) {
			result.ElapsedMs = o.Now().Sub(started).Milliseconds()
			return result, ErrTimeout
		}
		o.Sleep(o.Poll)
	}
}

func settled(operations []Operation) bool {
	if len(operations) == 0 {
		return false
	}
	for _, operation := range operations {
		if operation.WorkerActive || !terminal(operation.State) {
			return false
		}
	}
	return true
}

func allSucceeded(operations []Operation) bool {
	if len(operations) == 0 {
		return false
	}
	for _, operation := range operations {
		if operation.State != "succeeded" {
			return false
		}
	}
	return true
}

func terminal(state string) bool {
	switch state {
	case "succeeded", "failed", "interrupted", "cancelled":
		return true
	}
	return false
}
