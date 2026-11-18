package main

import (
	"time"

	"github.com/egoist/mygo/ui"
)

// chatPollDue is how long a chat on screen waits between two reads of its
// conversation. A chat keeps itself up to date on its own, so a reply that
// settles while the user stays in the conversation shows up without switching
// to another one and back, and without a hand made refresh.
const chatPollDue = time.Second

// keepFresh arms the next read of a visible chat. The view calls it on every
// frame: the timer brings a frame back when it is due, and that frame asks the
// console in the background, so the window never blocks on the read.
func (c *chatState) keepFresh(ctx *ui.Context) {
	if c.active == "" || c.source == nil || c.loading {
		return
	}
	now := ctx.Now()
	if c.pollAt.IsZero() {
		c.pollAt = now.Add(chatPollDue)
		ctx.After(chatPollDue)
		return
	}
	if now.Before(c.pollAt) {
		ctx.After(c.pollAt.Sub(now))
		return
	}
	c.pollAt = now.Add(chatPollDue)
	ctx.After(chatPollDue)
	if c.polling {
		return
	}
	c.polling = true
	go func() {
		c.refresh()
		onUI(c.window, func() { c.polling = false })
		c.frame()
	}()
}
