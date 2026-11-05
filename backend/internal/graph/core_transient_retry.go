package graph

import (
	"strings"

	"fmt"
)

// MAX_TRANSIENT_RETRIES bounds harness retries of an environment failure.
// A permanently broken endpoint still ends up in front of main.
const MAX_TRANSIENT_RETRIES = 2

// RetryDecisionRecord says whether a node execution failure retries itself or wakes main.
type RetryDecisionRecord struct {
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
}) RetryDecisionRecord {
	attempt := input.Attempt
	if attempt < 1 {
		attempt = 1
	}
	if strings.TrimSpace(input.Output) == "" {
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Reason: "节点失败但没有输出，无法判断是否为环境问题，交 main 诊断。", Exhausted: false}
	}
	// A failure the transport already sent again is settled: the same request
	// has been tried to its bound, so a turn retry would run the tools of the
	// turn a second time and file a second answer for one message.
	if retries, retried := TransportRetries(input.Output); retried {
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Exhausted: false,
			Reason: fmt.Sprintf("连接在收到任何回复前中断或损坏；传输层已有限次重试（自动重试 %d 次仍失败），交 main 处理。", retries)}
	}
	if IsDisconnectBeforeReply(input.Output) {
		// The transport already retried the dropped connection to its bound. A
		// turn retry would send the whole request again on top of that.
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Exhausted: false, Reason: "连接在收到任何回复前中断或损坏；传输层已有限次重试，交 main 处理。"}
	}
	if IsCapacityFailure(input.Output) {
		// The transport already gave the provider the pause it asked for. A turn
		// retry would send the whole request again and multiply the same budget.
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Exhausted: false, Reason: "provider 已按容量限制的暂停重试过；再重跑整轮只会倍增请求，交 main 处理。"}
	}
	if !IsEnvironmentFailure(input.Output) {
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Reason: "这是对代码/结果的判断，不是环境问题；重试不会有不同结论，交 main 处理。", Exhausted: false}
	}
	if attempt > MAX_TRANSIENT_RETRIES {
		return RetryDecisionRecord{
			Retry:     false,
			Attempt:   attempt,
			Exhausted: true,
			Reason:    fmt.Sprintf("环境问题已自动重试 %d 次仍未成功（第 %d 次失败），交 main 处理。", MAX_TRANSIENT_RETRIES, attempt),
		}
	}
	return RetryDecisionRecord{
		Retry:     true,
		Attempt:   attempt,
		Exhausted: false,
		Reason:    fmt.Sprintf("环境问题（网络/限流/上游），harness 自动重试第 %d 次（上限 %d）。", attempt, MAX_TRANSIENT_RETRIES),
	}
}
