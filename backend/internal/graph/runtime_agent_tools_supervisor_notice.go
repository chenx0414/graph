package graph

import (
	"errors"
	"strings"
)

// agentToolsSupervisor routes the two shapes of the supervisor channel: a
// question waits for an answer and stops the turn, a notice does neither.
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
	delivered := notify(PiAdapterSupervisorNotice{
		Text:      agentToolsTruncate(text, 2_000),
		Milestone: agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["milestone"])), 200),
		WorkID:    agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["workId"])), 200),
		Evidence:  agentToolsTruncate(strings.TrimSpace(agentToolsStringOrEmpty(params["evidence"])), 1_000),
		RequestID: requestID,
	})
	// No terminate: the sender keeps working after telling its supervisor.
	return agentToolsText(stringifyJSON(delivered))
}
