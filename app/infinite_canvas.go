package main

import (
	"math"
	"strconv"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

const (
	canvasMinZoom    = 0.3
	canvasMaxZoom    = 2.2
	canvasFitMinZoom = 0.55
)

type infiniteCanvas struct {
	zoom     float32
	x, y     float32
	fit      bool
	dragging bool
	lastX    float32
	lastY    float32
	worldW   float32
	worldH   float32
	viewW    float32
	viewH    float32
}

func (view *infiniteCanvas) clamp() {
	if view.worldW <= 0 || view.worldH <= 0 || view.viewW <= 0 || view.viewH <= 0 {
		return
	}
	const visible = float32(120)
	scaledW := view.worldW * view.zoom
	scaledH := view.worldH * view.zoom
	minVisibleX := minFleetFloat(visible, scaledW)
	minVisibleY := minFleetFloat(visible, scaledH)
	if view.x > view.viewW-minVisibleX {
		view.x = view.viewW - minVisibleX
	}
	if view.x+scaledW < minVisibleX {
		view.x = minVisibleX - scaledW
	}
	if view.y > view.viewH-minVisibleY {
		view.y = view.viewH - minVisibleY
	}
	if view.y+scaledH < minVisibleY {
		view.y = minVisibleY - scaledH
	}
}

func (view *infiniteCanvas) world(x, y float32) (float32, float32) {
	if view.zoom <= 0 {
		return x, y
	}
	return (x - view.x) / view.zoom, (y - view.y) / view.zoom
}

func (view *infiniteCanvas) zoomAt(x, y, factor float32) {
	if factor <= 0 || factor == 1 {
		return
	}
	next := clampFleetFloat(view.zoom*factor, canvasMinZoom, canvasMaxZoom)
	if next == view.zoom {
		return
	}
	wx, wy := view.world(x, y)
	view.zoom = next
	view.x = x - wx*next
	view.y = y - wy*next
	view.clamp()
}

func (view *infiniteCanvas) fitWorld(width, height, viewWidth, viewHeight float32) {
	if width <= 0 || height <= 0 || viewWidth <= 0 || viewHeight <= 0 {
		return
	}
	zoom := minFleetFloat(viewWidth/width, viewHeight/height)
	view.zoom = clampFleetFloat(zoom, canvasFitMinZoom, 1)
	view.worldW, view.worldH = width, height
	view.viewW, view.viewH = viewWidth, viewHeight
	view.x = (viewWidth - width*view.zoom) / 2
	view.y = (viewHeight - height*view.zoom) / 2
	view.fit = true
	view.clamp()
}

func clampFleetFloat(value, low, high float32) float32 {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func minFleetFloat(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

type canvasEdge struct {
	From, To string
	Points   [][2]float32
	Color    ui.Color
}

func (s *shellState) infiniteView(ctx *ui.Context, view *infiniteCanvas, worldW, worldH float32, edges []canvasEdge, hit func(x, y float32) bool, cards func(*ui.Context, *infiniteCanvas)) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	stage := ui.Box(ctx).Fill().Clip().Label("无限画布")
	stage.HandleInput(func(ev ui.InputEvent) bool {
		switch ev.Kind {
		case ui.InputScroll:
			view.x -= ev.DX
			view.y -= ev.DY
			view.clamp()
			return true
		case ui.InputZoom:
			view.zoomAt(ev.X, ev.Y, ev.Scale)
			return true
		case ui.InputPointerDown:
			if ev.Button == 1 || ev.Button == 2 {
				break
			}
			if hit != nil && hit(view.world(ev.X, ev.Y)) {
				return false
			}
			view.dragging = true
			view.lastX, view.lastY = ev.X, ev.Y
			return true
		case ui.InputPointerMove:
			if !view.dragging {
				return false
			}
			view.x += ev.X - view.lastX
			view.y += ev.Y - view.lastY
			view.lastX, view.lastY = ev.X, ev.Y
			view.clamp()
			return true
		case ui.InputPointerUp:
			if !view.dragging {
				return false
			}
			view.dragging = false
			return true
		}
		return false
	})
	stage.Draw(func(p *ui.Painter, r ui.Rect) {
		view.worldW, view.worldH = worldW, worldH
		view.viewW, view.viewH = r.W, r.H
		if !view.fit {
			view.fitWorld(worldW, worldH, r.W, r.H)
		}
		s.canvasGrid(p, r, view, t)
		for _, edge := range edges {
			if len(edge.Points) < 2 {
				continue
			}
			width, alpha := fleetEdgePaint(edge.From, edge.To, s.fleet.hoverID, float32(gwtheme.Stroke), fleetRestEdgeAlpha)
			color := edge.Color
			if color.A == 0 {
				color = t.Border
			}
			points := make([][2]float32, 0, len(edge.Points))
			for _, point := range edge.Points {
				points = append(points, [2]float32{r.X + view.x + point[0]*view.zoom, r.Y + view.y + point[1]*view.zoom})
			}
			p.StrokePolyline(points, width, color.Alpha(alpha))
		}
	})
	stage.Children(func() { cards(ctx, view) })
	ui.Row(ctx).Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
		kit.Text(ctx, formatCanvasZoom(view.zoom), t.Text.Xs).TextColor(t.Muted)
		if kit.Button(ctx, "居中", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
			view.fit = false
		}
		if kit.Button(ctx, "+", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
			view.zoomAt(200, 150, 1.2)
		}
		if kit.Button(ctx, "−", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs}).Clicked() {
			view.zoomAt(200, 150, 1/1.2)
		}
	})
}

func (s *shellState) canvasGrid(p *ui.Painter, r ui.Rect, view *infiniteCanvas, t gwtheme.Tokens) {
	step := float32(40) * view.zoom
	if step < 12 {
		step *= 4
	}
	startX := float32(math.Mod(float64(r.X+view.x), float64(step)))
	startY := float32(math.Mod(float64(r.Y+view.y), float64(step)))
	dot := t.Border.Alpha(0.35)
	for x := r.X + startX; x < r.X+r.W; x += step {
		for y := r.Y + startY; y < r.Y+r.H; y += step {
			p.Fill(ui.Rect{X: x, Y: y, W: 1, H: 1}, dot, 0.5)
		}
	}
}

func formatCanvasZoom(zoom float32) string {
	return strconv.Itoa(int(zoom*100)) + "%"
}
