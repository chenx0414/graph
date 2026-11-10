package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type taskSummary struct {
	ID            string `json:"id"`
	Request       string `json:"request"`
	Status        string `json:"status"`
	OpenQuestions int    `json:"openQuestions"`
}

type notificationState struct {
	Primed    bool              `json:"primed"`
	Questions map[string]int    `json:"questions"`
	Status    map[string]string `json:"status"`
}

type decision struct {
	TaskID string
	Title  string
	Body   string
}

func newNotificationState() *notificationState {
	return &notificationState{Questions: map[string]int{}, Status: map[string]string{}}
}

func parseTasks(payload []byte) ([]taskSummary, error) {
	tasks := []taskSummary{}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return tasks, nil
	}
	if err := json.Unmarshal(payload, &tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}

func taskDecisions(state *notificationState, tasks []taskSummary) ([]decision, int) {
	decisions := []decision{}
	questions := map[string]int{}
	status := map[string]string{}
	openTotal := 0
	for _, task := range tasks {
		open := task.OpenQuestions
		if open < 0 {
			open = 0
		}
		openTotal += open
		if state.Primed {
			if open > state.Questions[task.ID] {
				decisions = append(decisions, decision{TaskID: task.ID, Title: "任务需要处理", Body: clipRequest(task.Request)})
			}
			if was := state.Status[task.ID]; was != "" && was != task.Status && (task.Status == "completed" || task.Status == "failed") {
				title := "任务已完成"
				if task.Status == "failed" {
					title = "任务失败"
				}
				decisions = append(decisions, decision{TaskID: task.ID, Title: title, Body: clipRequest(task.Request)})
			}
		}
		questions[task.ID] = open
		status[task.ID] = task.Status
	}
	state.Primed = true
	state.Questions = questions
	state.Status = status
	return decisions, openTotal
}

func clipRequest(request string) string {
	runes := []rune(strings.TrimSpace(request))
	if len(runes) <= 80 {
		return string(runes)
	}
	return string(runes[:80])
}

func fetchTasks(address, token string) ([]taskSummary, error) {
	request, err := http.NewRequest("GET", strings.TrimSuffix(address, "/")+"/api/tasks", nil)
	if err != nil {
		return nil, err
	}
	if token = strings.TrimSpace(token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload := make([]byte, 0, 64*1024)
	buffer := make([]byte, 32*1024)
	for {
		read, err := response.Body.Read(buffer)
		if read > 0 {
			payload = append(payload, buffer[:read]...)
		}
		if err != nil {
			break
		}
	}
	return parseTasks(payload)
}
