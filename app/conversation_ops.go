package main

import (
	"encoding/json"
	"strings"
)

func (c *chatState) interrupt() {
	if c.active == "" {
		return
	}
	if _, err := c.api.post("/api/conversations/"+c.active+"/interrupt", map[string]string{"requestId": requestID("native-interrupt")}); err != nil {
		c.status = "打断失败：" + err.Error()
		c.frame()
		return
	}
	c.refresh()
	c.status = "已请求打断这一轮"
}

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

func (c *chatState) projectChoices() []string {
	if len(c.projects) > 0 {
		return c.projects
	}
	payload, err := c.api.get("/api/settings")
	if err != nil {
		c.status = "读不到项目列表：" + err.Error()
		return nil
	}
	var listed projectListPayload
	if err := json.Unmarshal(payload, &listed); err != nil {
		c.status = "项目列表不是预期的 JSON：" + err.Error()
		return nil
	}
	for _, project := range listed.Projects {
		if project.ID == "" {
			continue
		}
		c.projects = append(c.projects, project.ID)
	}
	return c.projects
}

type modelChoice struct {
	id        string
	thinking  string
	available []string
}

type modelListPayload struct {
	Models []struct {
		ID                   string `json:"id"`
		DefaultThinkingLevel string `json:"defaultThinkingLevel"`
		ThinkingOptions      []struct {
			Level string `json:"level"`
		} `json:"thinkingOptions"`
	} `json:"models"`
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
		choice := modelChoice{id: model.ID, thinking: model.DefaultThinkingLevel}
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

func (c *chatState) selectModel(model modelChoice, thinking string) {
	if c.active == "" {
		return
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
	c.modelMenu = false
	c.status = "已切到 " + shortModel(model.id) + " · 思考 " + thinking
	c.frame()
}

func (c *chatState) confirmDraft() {
	if c.active == "" || c.proposal.Version < 1 {
		return
	}
	branch := strings.TrimSpace(c.branch)
	if branch == "" {
		c.status = "目标分支不能为空"
		c.frame()
		return
	}
	body := map[string]any{
		"proposalVersion": c.proposal.Version,
		"draftRevision":   c.proposal.DraftRevision,
		"targetBranch":    branch,
		"requestId":       requestID("native-confirm"),
	}
	if _, err := c.api.post("/api/conversations/"+c.active+"/confirm", body); err != nil {
		c.status = "确认失败：" + err.Error()
		c.frame()
		return
	}
	c.proposal = draftProposal{}
	c.status = "已确认草案，开始执行（目标分支 " + branch + "）"
	c.frame()
}

func (c *chatState) bindProject(projectID string) {
	if c.active == "" || strings.TrimSpace(projectID) == "" {
		return
	}
	if _, err := c.api.post("/api/conversations/"+c.active+"/bind", map[string]string{"projectId": projectID, "requestId": requestID("native-bind")}); err != nil {
		c.status = "绑定失败：" + err.Error()
		c.frame()
		return
	}
	c.project = projectID
	c.binding = false
	c.status = "已绑定到 " + projectID
	c.frame()
}
