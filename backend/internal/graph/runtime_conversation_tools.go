package graph

import "strings"

// ConversationWriteAttempt is one Agent trying to write into another conversation.
type ConversationWriteAttempt struct {
	HostWrite bool
	Caller    string
	Target    string
}

// ConversationWriteRefusal is why this write is refused. Empty means it may proceed.
func ConversationWriteRefusal(attempt ConversationWriteAttempt) string {
	if !attempt.HostWrite {
		return "写别的会话需要完全访问：这次操作没有主机写权限，请把结果报告给使用者。"
	}
	if attempt.Target == attempt.Caller {
		return "这是你自己的会话：把结果直接回答给使用者，而不是发消息给自己。"
	}
	return ""
}

// AgentMessageText names the sending Agent in the text the target model reads.
func AgentMessageText(text string, conversationID, nodeID string) string {
	who := "另一个 Agent（会话 " + conversationID
	if nodeID != "" {
		who += " / " + nodeID
	}
	who += "）"
	return "[来自" + who + "的消息]\n\n" + strings.TrimSpace(text)
}

// ConversationToolService is the conversation service these tools need.
type ConversationToolService struct {
	List   func(archived *bool) any
	View   func(conversationID string, limit *int, after *int) any
	Events func(conversationID string, after *int, limit *int) any
	Chat   func(conversationID, text, requestID string, source any) any
	Steer  func(conversationID, requestID string) any
	Pause  func(conversationID, requestID string) any
	Resume func(conversationID, requestID string) any
}

// ConversationToolChannel is the tool surface one Agent session gets.
type ConversationToolChannel struct {
	List   func(archived *bool) any
	Read   func(conversationID string, limit, after int) any
	Follow func(conversationID string, after, limit int) any
	Send   func(conversationID, text, requestID string) any
	Steer  func(conversationID, text, requestID string) any
	Pause  func(conversationID, requestID string) any
	Resume func(conversationID, requestID string) any
}

// ConversationToolCaller is the session that owns the tools.
type ConversationToolCaller struct {
	ConversationID string
	TaskID         string
	NodeID         string
}

// OpenConversationTools records every handoff on the caller's own transcript.
func OpenConversationTools(service ConversationToolService, caller ConversationToolCaller, hostWrite bool, onHandoff func(map[string]any)) ConversationToolChannel {
	check := func(target string) {
		refusal := ConversationWriteRefusal(ConversationWriteAttempt{HostWrite: hostWrite, Caller: caller.ConversationID, Target: target})
		if refusal != "" {
			panic(errorString(refusal))
		}
	}
	handoff := func(record map[string]any) {
		if onHandoff != nil {
			onHandoff(record)
		}
	}
	source := func() any {
		return map[string]any{
			"kind":           "agent",
			"conversationId": caller.ConversationID,
			"nodeId":         caller.NodeID,
			"taskId":         caller.TaskID,
		}
	}
	return ConversationToolChannel{
		List: func(archived *bool) any { return service.List(archived) },
		Read: func(conversationID string, limit, after int) any {
			var afterPtr *int
			if after > 0 {
				value := after
				afterPtr = &value
			}
			limitValue := limit
			return service.View(conversationID, &limitValue, afterPtr)
		},
		Follow: func(conversationID string, after, limit int) any {
			afterValue, limitValue := after, limit
			return service.Events(conversationID, &afterValue, &limitValue)
		},
		Send: func(conversationID, text, requestID string) any {
			check(conversationID)
			receipt := service.Chat(conversationID, AgentMessageText(text, caller.ConversationID, caller.NodeID), requestID, source())
			shown := text
			if len(shown) > 500 {
				shown = shown[:500]
			}
			handoff(map[string]any{"action": "send", "caller": caller.ConversationID, "target": conversationID, "requestId": requestID, "text": shown})
			return receipt
		},
		Steer: func(conversationID, text, requestID string) any {
			check(conversationID)
			queued := service.Chat(conversationID, AgentMessageText(text, caller.ConversationID, caller.NodeID), requestID, source())
			steered := service.Steer(conversationID, requestID+":steer")
			shown := text
			if len(shown) > 500 {
				shown = shown[:500]
			}
			handoff(map[string]any{"action": "steer", "caller": caller.ConversationID, "target": conversationID, "requestId": requestID, "text": shown})
			return map[string]any{"queued": queued, "steered": steered}
		},
		Pause: func(conversationID, requestID string) any {
			check(conversationID)
			receipt := service.Pause(conversationID, requestID)
			handoff(map[string]any{"action": "pause", "caller": caller.ConversationID, "target": conversationID, "requestId": requestID})
			return receipt
		},
		Resume: func(conversationID, requestID string) any {
			check(conversationID)
			receipt := service.Resume(conversationID, requestID)
			handoff(map[string]any{"action": "resume", "caller": caller.ConversationID, "target": conversationID, "requestId": requestID})
			return receipt
		},
	}
}

type errorString string

func (e errorString) Error() string { return string(e) }
