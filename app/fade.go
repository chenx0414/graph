package main

import "github.com/egoist/mygo/ui"

const fadeEdgeClearance = float32(12)

func fadeInsets(scroll *ui.ScrollState) (top, bottom float32) {
	if scroll == nil || scroll.MaxY <= 0 {
		return 0, 0
	}
	if scroll.Y <= 0.5 {
		top = fadeEdgeClearance
	}
	if scroll.MaxY-scroll.Y <= 0.5 {
		bottom = fadeEdgeClearance
	}
	return top, bottom
}
