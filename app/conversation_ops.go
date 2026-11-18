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
	if c.active == "" {
		return
	}
	action := "pause"
	if !paused {
		action = "resume"
	}
	if _, err := c.api.post("/api/conversations/"+c.active+"/"+action, map[string]string{"requestId": requestID("native-" + action)}); err != nil {
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
	if c.modelsLoading || len(c.models) > 0 {
		return
	}
	c.modelsLoading = true
	c.modelChoices()
	c.modelsLoading = false
	c.frame()
}

func (c *chatState) modelChoices() []modelChoice {
	if len(c.models) > 0 {
		return c.models
	}
	payload, err := c.api.get("/api/settings")
	if err != nil {
		c.status = "读不到模型列表：" + err.Error()
		return nil
	}
	var listed modelListPayload
	if err := json.Unmarshal(payload, &listed); err != nil {
		c.status = "模型列表不是预期的 JSON：" + err.Error()
		return nil
	}
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
		c.models = append(c.models, choice)
	}
	return c.models
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
	if c.active == "" {
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
	if _, err := c.api.post("/api/conversations/"+c.active+"/model", body); err != nil {
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
}
