package main

import "github.com/egoist/mygo/ui"

func svgIcon(body string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`))
}

var (
	iconHome    = svgIcon(`<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/>`)
	iconChat    = svgIcon(`<path d="M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="M7.5 8.5h9"/><path d="M7.5 12h6"/>`)
	iconClock   = svgIcon(`<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/><path d="M12 7v5.2l3.4 2"/>`)
	iconDoc     = svgIcon(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>`)
	iconShare   = svgIcon(`<path d="M18 2.5a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z"/><path d="M6 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z"/><path d="M18 15.9a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z"/><path d="m8.5 10.6 7-3.7"/><path d="m8.5 13.4 7 3.7"/>`)
	iconGrid    = svgIcon(`<path d="M4 4h6v6H4Z"/><path d="M14 4h6v6h-6Z"/><path d="M4 14h6v6H4Z"/><path d="M14 14h6v6h-6Z"/>`)
	iconGear    = svgIcon(`<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.12.61.6 1.1 1.21 1.22H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"/>`)
	iconSearch  = svgIcon(`<path d="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z"/><path d="m21 21-4.35-4.35"/>`)
	iconList    = svgIcon(`<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>`)
	iconFit     = svgIcon(`<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`)
	iconFocus   = svgIcon(`<path d="M3 4h18v12H3Z"/><path d="M8 20h8"/><path d="M12 16v4"/>`)
	iconClose   = svgIcon(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`)
	iconSend    = svgIcon(`<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>`)
	iconPlus    = svgIcon(`<path d="M12 5v14"/><path d="M5 12h14"/>`)
	iconGraph   = svgIcon(`<path d="M5 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/><path d="M19 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/><path d="M19 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/><path d="m7.2 9.4 9.6 5.2"/><path d="M7.5 8h9"/>`)
	iconArchive = svgIcon(`<path d="M4 7h16v13H4Z"/><path d="M2 3h20v4H2Z"/><path d="M10 12h4"/>`)
)
