package main

import (
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// answerClockWindow bounds how old the start of a still streaming answer may be
// for the chat to trust it against the clock. A conversation restored from the
// console can carry a timestamp from another day, and a stopwatch counting from
// it would be a made up number rather than a measurement.
const answerClockWindow = 12 * time.Hour

// answerClockKey names the answer a stopwatch reading belongs to. A streaming
// answer reaches the chat as a live entry and comes back from the console under
// another message ID once it settles, so the operation is the name both share.
func answerClockKey(message transcriptMessage) string {
	if message.OperationID != "" {
		return "op:" + message.OperationID
	}
	if message.ID != "" {
		return "id:" + message.ID
	}
	return ""
}

// answerClock reports how long an answer has been running, and remembers the
// last reading of a streaming answer so the settled answer keeps it instead of
// waiting for the next poll. The second result is false when there is nothing
// measured to show: no timestamp, a timestamp from long ago, or a settled answer
// the window never saw running.
func (c *chatState) answerClock(message transcriptMessage, now time.Time) (time.Duration, bool) {
	if message.Role != "assistant" || message.CreatedAt <= 0 {
		return 0, false
	}
	key := answerClockKey(message)
	if key == "" {
		return 0, false
	}
	start := time.UnixMilli(message.CreatedAt)
	if messageStreaming(message) {
		elapsed := now.Sub(start)
		if elapsed < 0 || elapsed > answerClockWindow {
			return 0, false
		}
		c.rememberAnswerClock(key, elapsed)
		return elapsed, true
	}
	if recorded, ok := c.answerClocks[key]; ok && recorded > 0 {
		return time.Duration(recorded) * time.Millisecond, true
	}
	return 0, false
}

// rememberAnswerClock keeps the reading of a streaming answer for the frame that
// shows it settled.
func (c *chatState) rememberAnswerClock(key string, elapsed time.Duration) {
	if c.answerClocks == nil {
		c.answerClocks = map[string]int64{}
	}
	c.answerClocks[key] = elapsed.Milliseconds()
}

// answerClockRow draws the stopwatch above an answer that is still being written,
// or keeps its last reading above the answer that just landed. It asks for the
// next second while the answer runs, so the window keeps counting on its own.
func (c *chatState) answerClockRow(ctx *ui.Context, message transcriptMessage) {
	elapsed, ok := c.answerClock(message, ctx.Now())
	if !ok {
		return
	}
	t := gwtheme.Of(ctx)
	label := "已用时 " + codexWorkedFor(elapsed)
	if messageStreaming(message) {
		label = "正在回复 · 用时 " + codexWorkedFor(elapsed)
		ctx.After(time.Second)
	}
	kit.Text(ctx, label, t.Text.Xs).TextColor(t.Muted).SingleLine()
}
