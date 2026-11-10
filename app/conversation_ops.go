package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

func (c *chatState) interrupt() {
	if c.active == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"requestId": requestID("native-interrupt")})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/interrupt", bytes.NewReader(body))
	if err != nil {
		c.status = "打断失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "打断失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "打断被拒绝：" + response.Status
		c.frame()
		return
	}
	c.refresh()
	c.status = "已请求打断这一轮"
}

func (c *chatState) cancelQueued(messageID string) {
	body, _ := json.Marshal(map[string]string{"requestId": requestID("native-cancel")})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/messages/"+messageID+"/cancel", bytes.NewReader(body))
	if err != nil {
		c.status = "撤销失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "撤销失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "撤销被拒绝：" + response.Status
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
	body, _ := json.Marshal(map[string]string{"requestId": requestID("native-" + action)})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/"+action, bytes.NewReader(body))
	if err != nil {
		c.status = "操作失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "操作失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "操作被拒绝：" + response.Status
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
	payload, err := daemonGet(c.address, c.token, "/api/settings")
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
	payload, err := daemonGet(c.address, c.token, "/api/settings")
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
	body, _ := json.Marshal(map[string]string{
		"model":         model.id,
		"thinkingLevel": thinking,
		"requestId":     requestID("native-model"),
	})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/model", bytes.NewReader(body))
	if err != nil {
		c.status = "换模型失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "换模型失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "换模型被拒绝：" + response.Status
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
	body, _ := json.Marshal(map[string]any{
		"proposalVersion": c.proposal.Version,
		"draftRevision":   c.proposal.DraftRevision,
		"targetBranch":    branch,
		"requestId":       requestID("native-confirm"),
	})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/confirm", bytes.NewReader(body))
	if err != nil {
		c.status = "确认失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 60 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "确认失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "确认被拒绝：" + response.Status
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
	body, _ := json.Marshal(map[string]string{"projectId": projectID, "requestId": requestID("native-bind")})
	request, err := http.NewRequest("POST", strings.TrimSuffix(c.address, "/")+"/api/conversations/"+c.active+"/bind", bytes.NewReader(body))
	if err != nil {
		c.status = "绑定失败：" + err.Error()
		c.frame()
		return
	}
	if token := strings.TrimSpace(c.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		c.status = "绑定失败：" + err.Error()
		c.frame()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.status = "绑定被拒绝：" + response.Status
		c.frame()
		return
	}
	c.project = projectID
	c.binding = false
	c.status = "已绑定到 " + projectID
	c.frame()
}
