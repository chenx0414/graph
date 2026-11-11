package kit

import (
	"time"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/theme"
)

func ink(t theme.Tokens) ui.Color {
	if t.Dark {
		return t.Background
	}
	return t.Foreground
}

func colors(d time.Duration) ui.ElementTransition {
	return ui.ElementTransition{Colors: true, Duration: d}
}
