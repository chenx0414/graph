package graph

import (
	"strings"

	"fmt"
)

const MAX_TRANSIENT_RETRIES = 2

type RetryDecisionRecord struct {
	Retry bool `json:"retry"`
	Attempt int `json:"attempt"`
	Reason string `json:"reason"`
	Exhausted bool `json:"exhausted"`
}

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
	if retries, retried := TransportRetries(input.Output); retried {
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Exhausted: false,
			Reason: fmt.Sprintf("连接在收到任何回复前中断或损坏；传输层已有限次重试（自动重试 %d 次仍失败），交 main 处理。", retries)}
	}
	if IsDisconnectBeforeReply(input.Output) {
		return RetryDecisionRecord{Retry: false, Attempt: attempt, Exhausted: false, Reason: "连接在收到任何回复前中断或损坏；传输层已有限次重试，交 main 处理。"}
	}
	if IsCapacityFailure(input.Output) {
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
