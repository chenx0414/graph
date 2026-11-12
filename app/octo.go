package main

import (
	"time"

	"github.com/egoist/mygo/ui"
	gwtheme "graph/app/gwui/theme"
)

const (
	octoSwimPeriod  = 900 * time.Millisecond
	octoSwimStep    = octoSwimPeriod / 8
	octoBlinkPeriod = 4600 * time.Millisecond
	octoLookPeriod  = 7300 * time.Millisecond

	octoBlinkStart = 4393 * time.Millisecond
	octoBlinkEnd   = 4508 * time.Millisecond

	octoLookLeftStart  = 1533 * time.Millisecond
	octoLookLeftEnd    = 2482 * time.Millisecond
	octoLookRightStart = 4234 * time.Millisecond
	octoLookRightEnd   = 5183 * time.Millisecond

	octoSpriteWidth  = 30
	octoSpriteHeight = 24
	octoViewHeight   = octoSpriteHeight + 2
)

var (
	octoLifts          = [8]int{0, 0, 1, 1, 2, 1, 1, 0}
	octoBlinkPatch     = diffGrid(octoFrames[0], octoBlinkGrid)
	octoLookLeftPatch  = diffGrid(octoFrames[0], octoLookLeftGrid)
	octoLookRightPatch = diffGrid(octoFrames[0], octoLookRightGrid)
)

type octoExpression struct {
	Blink bool
	Look  int
}

func octoFrameAt(elapsed time.Duration) (frame int, lift int) {
	phase := elapsed.Milliseconds() % octoSwimPeriod.Milliseconds()
	frame = int(phase * int64(len(octoFrames)) / octoSwimPeriod.Milliseconds())
	if frame >= len(octoFrames) {
		frame = len(octoFrames) - 1
	}
	return frame, octoLifts[frame]
}

func octoExpressionAt(elapsed time.Duration) octoExpression {
	expression := octoExpression{}
	blink := elapsed.Milliseconds() % octoBlinkPeriod.Milliseconds()
	expression.Blink = blink >= octoBlinkStart.Milliseconds() && blink < octoBlinkEnd.Milliseconds()
	look := elapsed.Milliseconds() % octoLookPeriod.Milliseconds()
	switch {
	case look >= octoLookLeftStart.Milliseconds() && look < octoLookLeftEnd.Milliseconds():
		expression.Look = -1
	case look >= octoLookRightStart.Milliseconds() && look < octoLookRightEnd.Milliseconds():
		expression.Look = 1
	}
	return expression
}

func octoNextPaint(elapsed time.Duration) time.Duration {
	wait := octoSwimStep - elapsed%octoSwimStep
	consider := func(at time.Duration) {
		if at > elapsed && at-elapsed < wait {
			wait = at - elapsed
		}
	}
	considerWindow := func(period, start, end time.Duration) {
		phase := elapsed % period
		switch {
		case phase < start:
			consider(elapsed - phase + start)
		case phase < end:
			consider(elapsed - phase + end)
		default:
			consider(elapsed - phase + period + start)
		}
	}
	considerWindow(octoBlinkPeriod, octoBlinkStart, octoBlinkEnd)
	considerWindow(octoLookPeriod, octoLookLeftStart, octoLookLeftEnd)
	considerWindow(octoLookPeriod, octoLookRightStart, octoLookRightEnd)
	return wait
}

func octoGridAt(elapsed time.Duration) ([]string, int) {
	frame, lift := octoFrameAt(elapsed)
	grid := octoFrames[frame]
	expression := octoExpressionAt(elapsed)
	if expression.Blink {
		grid = patchGrid(grid, octoBlinkPatch)
	}
	switch expression.Look {
	case -1:
		grid = patchGrid(grid, octoLookLeftPatch)
	case 1:
		grid = patchGrid(grid, octoLookRightPatch)
	}
	return grid, lift
}

func diffGrid(base, other []string) []string {
	out := make([]string, len(base))
	for y := range base {
		row := []byte(base[y])
		for x := range row {
			if other[y][x] == base[y][x] {
				row[x] = '.'
			} else {
				row[x] = other[y][x]
			}
		}
		out[y] = string(row)
	}
	return out
}

func patchGrid(base, patch []string) []string {
	out := make([]string, len(base))
	for y := range base {
		row := []byte(base[y])
		for x := range row {
			if patch[y][x] != '.' {
				row[x] = patch[y][x]
			}
		}
		out[y] = string(row)
	}
	return out
}

func octoLoader(ctx *ui.Context) ui.Element {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	box := ui.Box(ctx).Size(th.Space(7.5), th.Space(6.5))
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		now := p.Now()
		elapsed := time.Duration(now.UnixMilli()) * time.Millisecond
		p.After(octoNextPaint(elapsed))
		drawOcto(p, r, elapsed, t.Foreground)
	})
	return box
}

func drawOcto(p *ui.Painter, area ui.Rect, elapsed time.Duration, ink ui.Color) {
	scale := min(area.W/octoSpriteWidth, area.H/octoViewHeight)
	if scale <= 0 {
		return
	}
	paper := ui.Hex("#F6F8FA")
	pupil := ui.Hex("#1B1F24")
	originX := area.X + (area.W-octoSpriteWidth*scale)/2
	originY := area.Y + (area.H-octoViewHeight*scale)/2
	grid, lift := octoGridAt(elapsed)
	top := originY + float32(lift)*scale
	for row, line := range grid {
		for x := 0; x < len(line); {
			cell := line[x]
			width := 1
			for x+width < len(line) && line[x+width] == cell {
				width++
			}
			if cell != '.' {
				color := ink
				switch cell {
				case 'w', 'c', 'g':
					color = paper
				case 'p':
					color = pupil
				}
				p.Fill(ui.Rect{
					X: originX + float32(x)*scale,
					Y: top + float32(row)*scale,
					W: float32(width) * scale,
					H: scale,
				}, color, 0)
			}
			x += width
		}
	}
}
