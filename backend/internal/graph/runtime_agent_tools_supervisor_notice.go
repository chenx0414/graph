package graph

import (
	"errors"
	"strings"
)

func agentToolsSupervisor(ask func(PiAdapterAskedQuestion), notify func(notice PiAdapterSupervisorNotice) any, params map[string]any) any {
	kind := strings.TrimSpace(agentToolsStringOrEmpty(params["kind"]))
	if kind == "" || kind == "question" {
		return agentToolsAsk(ask, params)
	}
	if kind != "notice" {
		panic(errors.New("kind must be question or notice"))
	}
	text := strings.TrimSpace(agentToolsStringOrEmpty(params["prompt"]))
	if text == "" {
		panic(errors.New("A notice is required"))
	}
	if notify == nil {
		panic(errors.New("This Agent session cannot notify a supervisor"))
	}
	requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
	if requestID == "" || len(requestID) > 200 {
		panic(errors.New("A bounded requestId is required"))
	}
	version := 0
	if value, ok := agentToolsNumber(params["artifactVersion"]); ok && value > 0 {
		version = int(value)
	}
	delivered := notify(PiAdapterSupervisorNotice{
		Text:            agentToolsTruncate(text, 2_000),
		Milestone:       agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["milestone"])), 200),
		WorkID:          agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["workId"])), 200),
		Evidence:        agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["evidence"])), 1_000),
		ArtifactID:      agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["artifactId"])), 200),
		ArtifactVersion: version,
		RequestID:       requestID,
	})
	return agentToolsText(stringifyJSON(delivered))
}
