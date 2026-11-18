package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// chatRow is one rendered line of the transcript list: a single message, a
// folded tool run, or the fold that gathers the steps preceding a final answer.
type chatRow struct {
	kind    string // "message", "tools" or "fold"
	run     transcriptRun
	steps   []transcriptRun
	key     string
	foldKey string
}

func chatRowForRun(run transcriptRun) chatRow {
	kind := "message"
	if run.tools {
		kind = "tools"
	}
	return chatRow{kind: kind, run: run, key: fmt.Sprint(runIdentity(run))}
}

func chatRowUserRun(run transcriptRun) bool {
	return !run.tools && len(run.messages) == 1 && run.messages[0].Role == "user"
}

func chatRowAnswerRun(run transcriptRun) bool {
	return !run.tools && len(run.messages) == 1 && run.messages[0].Role == "assistant"
}

// chatFoldRows groups each round from its user message to the final answer,
// gathering the interim thoughts and tool runs that came before that answer
// into one collapsed fold. A round whose answer is still streaming keeps its
// steps open, so the reader sees the work while it happens.
func chatFoldRows(runs []transcriptRun) []chatRow {
	rows := make([]chatRow, 0, len(runs))
	for index := 0; index < len(runs); {
		run := runs[index]
		if !chatRowUserRun(run) {
			rows = append(rows, chatRowForRun(run))
			index++
			continue
		}
		rows = append(rows, chatRowForRun(run))
		end := index + 1
		for end < len(runs) && !chatRowUserRun(runs[end]) {
			end++
		}
		final := -1
		for probe := end - 1; probe > index; probe-- {
			if chatRowAnswerRun(runs[probe]) && !runActive(runs[probe]) {
				final = probe
				break
			}
		}
		// The fold only appears once the round ends with its final answer. A
		// round whose last run is still a tool keeps its steps in the open.
		if final == end-1 && final > index+1 {
			foldKey := "fold:" + fmt.Sprint(runIdentity(run))
			steps := append([]transcriptRun(nil), runs[index+1:final]...)
			rows = append(rows, chatRow{kind: "fold", steps: steps, key: foldKey, foldKey: foldKey})
			rows = append(rows, chatRowForRun(runs[final]))
		} else {
			for next := index + 1; next < end; next++ {
				rows = append(rows, chatRowForRun(runs[next]))
			}
		}
		index = end
	}
	return rows
}

func foldDuration(row chatRow, now time.Time) (time.Duration, bool) {
	var first, last int64
	for _, step := range row.steps {
		for _, message := range step.messages {
			if message.CreatedAt <= 0 {
				continue
			}
			if first == 0 || message.CreatedAt < first {
				first = message.CreatedAt
			}
			if message.CreatedAt > last {
				last = message.CreatedAt
			}
		}
	}
	if first == 0 || last <= first {
		return 0, false
	}
	if now.Sub(time.UnixMilli(first)) > runClockWindow {
		return 0, false
	}
	return time.Duration(last-first) * time.Millisecond, true
}

func (c *chatState) foldRow(ctx *ui.Context, row chatRow) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	open := c.expanded[row.foldKey]
	// The row keeps its short label so the fold stays addressable by its
	// stable name; the rendered text carries the extra timing reading.
	const label = "思考与工具调用"
	shown := label
	if elapsed, ok := foldDuration(row, ctx.Now()); ok {
		shown = label + " · 用时 " + codexWorkedFor(elapsed)
	}
	header := ui.Row(ctx).FillWidth().Height(th.Space(7)).Gap(th.Space(1.5)).AlignItems(ui.Center).
		Label(label).Focusable()
	header.OnClick(func() {
		c.expanded[row.foldKey] = !open
		c.frame()
	})
	header.Children(func() {
		chevron := ui.Icon(ctx, iconChevron).Size(gwtheme.IconXs, gwtheme.IconXs).TextColor(t.Muted)
		if open {
			chevron.Rotate(180)
		}
		kit.Text(ctx, shown, t.Text.Xs).TextColor(t.Muted).SingleLine()
	})
	kit.Separator(ctx, false)
	if !open {
		return
	}
	for _, step := range row.steps {
		if step.tools {
			c.toolRow(ctx, step)
			continue
		}
		c.messageRow(ctx, step.messages[0])
	}
}
