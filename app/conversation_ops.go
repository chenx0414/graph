package main

import (
	"encoding/json"
	"strings"
)

func (c *chatState) cancelQueued(messageID string) {
	if _, err := c.api.post("/api/conversations/"+c.active+"/messages/"+messageID+"/cancel", map[string]string{"requestId": requestID("native-cancel")}); err != nil {
		c.status = "撤销失败：" + err.Error()
		c.frame()
		return
	}
	c.refresh()
	c.status = "已撤销排队消息"
}

func (c *chatState) setPaused(paused bool) {
	// The button starts this on a bare goroutine; the request stays there and the
	// paused flag is written where the render reads it.
	active := readShell(c.window, func() string { return c.active })
	if active == "" {
		return
	}
	action := "pause"
	if !paused {
		action = "resume"
	}
	_, err := c.api.post("/api/conversations/"+active+"/"+action, map[string]string{"requestId": requestID("native-" + action)})
	onUI(c.window, func() {
		if err != nil {
			c.status = "操作失败：" + err.Error()
			c.frame()
			return
		}
		c.paused = paused
		if paused {
			c.status = "已暂停：这一轮与队列都会停下，点「继续」接着跑"
		} else {
			c.status = "已继续"
		}
		c.frame()
	})
}

type projectListPayload struct {
	Projects []struct {
		ID       string `json:"id"`
		Archived bool   `json:"archived"`
	} `json:"projects"`
}

type modelChoice struct {
	id        string
	provider  string
	thinking  string
	available []string
}

func (c *chatState) modelProviderOf(model modelChoice) string {
	if model.provider != "" {
		return model.provider
	}
	return modelProviderID(model.id)
}

type modelListPayload struct {
	Models []struct {
		ID                   string `json:"id"`
		Provider             string `json:"provider"`
		DefaultThinkingLevel string `json:"defaultThinkingLevel"`
		ThinkingOptions      []struct {
			Level string `json:"level"`
		} `json:"thinkingOptions"`
	} `json:"models"`
}

func (c *chatState) loadModels() {
	// A render asks for the model list, so the request cannot be made here: it
	// would block the frame and then write the fields the frame is reading.
	onUI(c.window, func() {
		if c.modelsLoading || len(c.models) > 0 {
			return
		}
		c.modelsLoading = true
	})
	if len(readShell(c.window, func() []modelChoice { return c.models })) > 0 {
		return
	}
	go func() {
		choices, payload, err := c.fetchModels()
		onUI(c.window, func() {
			defer func() { c.modelsLoading = false }()
			if err != nil {
				c.status = err.Error()
				return
			}
			if len(c.models) > 0 {
				// Something filled the list while the request was out; keep it.
				return
			}
			c.models = choices
			_ = payload
			c.frame()
		})
	}()
}

// fetchModels reads the settings document off the renderer.
func (c *chatState) fetchModels() ([]modelChoice, []byte, error) {
	payload, err := c.api.get("/api/settings")
	if err != nil {
		return nil, nil, errStatus(readFailureText(err, "模型列表"))
	}
	var listed modelListPayload
	if err := json.Unmarshal(payload, &listed); err != nil {
		return nil, nil, errStatus("模型列表不是预期的 JSON：" + err.Error())
	}
	var choices []modelChoice
	for _, model := range listed.Models {
		if model.ID == "" {
			continue
		}
		choice := modelChoice{id: model.ID, provider: model.Provider, thinking: model.DefaultThinkingLevel}
		for _, option := range model.ThinkingOptions {
			if option.Level != "" {
				choice.available = append(choice.available, option.Level)
			}
		}
		choices = append(choices, choice)
	}
	return choices, payload, nil
}

func shortModel(id string) string {
	if index := strings.LastIndex(id, "/"); index >= 0 && index+1 < len(id) {
		return id[index+1:]
	}
	if index := strings.Index(id, ":"); index >= 0 && index+1 < len(id) {
		return id[index+1:]
	}
	return id
}

type modelTelemetryPayload struct {
	Telemetry struct {
		Model         string `json:"model"`
		ThinkingLevel string `json:"thinkingLevel"`
	} `json:"telemetry"`
}

func parseModelTelemetry(payload []byte) (string, string) {
	var body modelTelemetryPayload
	if json.Unmarshal(payload, &body) != nil {
		return "", ""
	}
	return strings.TrimSpace(body.Telemetry.Model), strings.TrimSpace(body.Telemetry.ThinkingLevel)
}

func (c *chatState) syncModelTelemetry(payload []byte) {
	model, thinking := parseModelTelemetry(payload)
	if c.modelTelemetryHold > 0 {
		c.modelTelemetryHold--
		return
	}
	if model != "" {
		c.currentModel = model
	}
	if thinking != "" {
		c.currentThinking = thinking
	}
}

func (c *chatState) selectModel(model modelChoice, thinking string) {
	// The picker starts this on a bare goroutine: the request stays there, and the
	// choice it settles is written where the composer reads it.
	active := readShell(c.window, func() string { return c.active })
	if active == "" {
		return
	}
	if thinking == "" {
		thinking = "off"
	}
	body := map[string]string{
		"model":         model.id,
		"thinkingLevel": thinking,
		"requestId":     requestID("native-model"),
	}
	_, err := c.api.post("/api/conversations/"+active+"/model", body)
	onUI(c.window, func() {
		if err != nil {
			c.status = "换模型失败：" + err.Error()
			c.frame()
			return
		}
		c.currentModel = model.id
		c.currentThinking = thinking
		c.modelTelemetryHold = 1
		c.status = ""
		c.problem = ""
		c.frame()
	})
}

func (c *chatState) newAgentContext() {
	if c.active == "" {
		return
	}
	body := map[string]string{"requestId": requestID("new-context")}
	if _, err := c.api.post("/api/conversations/"+c.active+"/new-context", body); err != nil {
		c.status = "新开 Agent 上下文失败：" + err.Error()
		c.frame()
		return
	}
	c.status = "已开启新的 Agent 上下文"
	c.frame()
	if c.contextReset != nil {
		c.contextReset()
	}
}

// modelChoices answers from what is already loaded. A caller that needs the list
// starts loadModels and reads again on the next frame.
func (c *chatState) modelChoices() []modelChoice {
	if len(c.models) > 0 {
		return c.models
	}
	c.loadModels()
	return readShell(c.window, func() []modelChoice { return c.models })
}
