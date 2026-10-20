package graph

import (
	"fmt"
	"strings"
)

// MAX_TRANSIENT_RETRIES bounds harness retries of an environment failure.
// A permanently broken endpoint still ends up in front of main.
const MAX_TRANSIENT_RETRIES = 2

// RetryDecisionResult says whether a node execution failure retries itself or wakes main.
// TODO(port): TypeScript exports both the RetryDecision type and the retryDecision function.
// Go cannot export both under RetryDecision, so the struct is RetryDecisionResult.
type RetryDecisionResult struct {
	Retry bool `json:"retry"`
	// Attempt is the attempt this failure was, and the one a retry would be.
	Attempt int `json:"attempt"`
	// Reason is why main is woken, or why the harness retries. Never empty.
	Reason string `json:"reason"`
	// Exhausted is true when the only thing left was to wake main because the bound ran out.
	Exhausted bool `json:"exhausted"`
}

// RetryDecision reports whether a failure retries itself.
// attempt is 1 for the first failure. A transient failure up to MAX_TRANSIENT_RETRIES
// retries itself; anything else wakes main.
func RetryDecision(input struct {
	Output  string
	Attempt int
}) RetryDecisionResult {
	attempt := input.Attempt
	if attempt < 1 {
		attempt = 1
	}
	if strings.TrimSpace(input.Output) == "" {
		return RetryDecisionResult{Retry: false, Attempt: attempt, Reason: "节点失败但没有输出，无法判断是否为环境问题，交 main 诊断。", Exhausted: false}
	}
	if !IsEnvironmentFailure(input.Output) {
		return RetryDecisionResult{Retry: false, Attempt: attempt, Reason: "这是对代码/结果的判断，不是环境问题；重试不会有不同结论，交 main 处理。", Exhausted: false}
	}
	if attempt > MAX_TRANSIENT_RETRIES {
		return RetryDecisionResult{
			Retry:     false,
			Attempt:   attempt,
			Exhausted: true,
			Reason:    fmt.Sprintf("环境问题已自动重试 %d 次仍未成功（第 %d 次失败），交 main 处理。", MAX_TRANSIENT_RETRIES, attempt),
		}
	}
	return RetryDecisionResult{
		Retry:     true,
		Attempt:   attempt,
		Exhausted: false,
		Reason:    fmt.Sprintf("环境问题（网络/限流/上游），harness 自动重试第 %d 次（上限 %d）。", attempt, MAX_TRANSIENT_RETRIES),
	}
}
