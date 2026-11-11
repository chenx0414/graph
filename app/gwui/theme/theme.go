package theme

import (
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/egoist/mygo/ui"
	p "graph/app/gwui/palette"
)

type Tokens struct {
	Dark                                                            bool
	Window, Sidebar, Background, Foreground, Muted, Border, Grid, Primary ui.Color
	PrimaryText, SidebarSelected, Hover, Success                    ui.Color
	GlassBg, GlassBorder, GlassHover ui.Color
	HoverTint                                                       ui.Color
	WarningBg, WarningBorder, WarningText, Danger, DangerBg         ui.Color
	SuccessBg, SuccessBorder, SuccessText, DangerBorder, DangerText ui.Color
	InsBg, InsText, DelBg, DelText                                  ui.Color
	Attention, Unread, Input, Ring                                  ui.Color
	Idle ui.Color
	Outline ui.Color
	FloatInset ui.Color
	DividerHover ui.Color
	Raised ui.Color
	Scrim, AlertScrim ui.Color
	Card ui.Color
	MarkTile ui.Color
	OnSolid ui.Color
	Highlight, HighlightText ui.Color
	FontSize, BodyFontSize, Scale float32
	Radius                        RadiusScale
	Text                          TextScale
}

type RadiusScale struct{ Xs, Sm, Md, Lg, Xl, X2l, X3l, X4l, Full float32 }

type TextScale struct{ Xs, Sm, Base, Body, Lg, Title, Xl, X2l, Display float32 }

const (
	LineXs, LineSm, LineBase, LineBody, LineLg = 1.4, 1.45, 1.3, 1.3, 1.5
	LineTitle, LineXl, LineX2l, LineDisplay    = 1.4, 1.35, 1.3, 1.25
	LineReading, LineSummary, LineProse        = 1.75, 1.65, 1.6
	LineLede, LineTight                        = 1.7, 1
	LineCJK                                    = 1.4
	LineSubject                                = 1.35
	LineRow                                    = 1.45
)

func LineFor(s string) float32 {
	if strings.ContainsFunc(s, func(r rune) bool {
		return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
	}) {
		return LineRow
	}
	return LineBody
}

func (s TextScale) Line(size float32) float32 {
	switch size {
	case s.Xs:
		return LineXs
	case s.Sm:
		return LineSm
	case s.Base:
		return LineBase
	case s.Lg:
		return LineLg
	case s.Title:
		return LineTitle
	case s.Xl:
		return LineXl
	case s.X2l:
		return LineX2l
	case s.Display:
		return LineDisplay
	}
	return LineBody
}

const (
	Stroke       = 1
	MaterialTint = 0.6
	Hairline        = 0.01
	SidebarWidth    = 248
	SidebarMinWidth = 240
	SidebarMaxWidth = 480
	SidebarCollapsePull = 80
	ListWidth           = 340
	ListMinWidth        = 280
	ListMaxWidth        = 560
	TopBarHeight        = 44
	DialogSmWidth       = 440
	BackdropBlur        = 4
	GlassBlur           = 20
	DialogLift          = 0.2
	DialogMinTop        = 32
	DialogTop           = 64
	SheetWidth          = 560
	DialogWideWidth     = 640
	DialogWideMax       = 788
	SheetMaxHeight      = 760
	AsideWidth          = 440
	FormMaxWidth        = 520
	ContentMaxWidth     = 1040
	RuleAsideWidth      = 340
	RuleConnector       = 20
	RuleFieldWidth      = 108
	RuleOpWidth         = 96
	RuleActionWidth     = 200
	ControlWidth        = 220
	SettingsMaxWidth    = 760
	SettingsSelectMin   = 200
	SettingsSelectMax   = 280
	UsageSelectMin      = 240
	SettingsInputWidth  = 260
	SignatureEditorHeight = 257
	HeadingGap            = 6
	SectionGap            = 10
	PortWidth             = 90
	SelectMinWidth        = 120
	FilterMenuMin         = 200
	LabelMenuWidth        = 240
	CiteCardWidth         = 320
	CiteChip              = 16
	DetailsWidth          = 400
	DetailsLabel          = 72
	SyncMenuWidth         = 320
	SecurityCardWidth     = 320
	LabelSwatch           = 32
	LabelSwatchDot        = 24
	LabelSwatchRing       = 2
	LabelIconCell         = 36
	ToastMaxWidth         = 420
	ToastMax              = 3
	TitleButtonHeight     = 24
	PopupOffset           = 4
	SelectedBorder        = 2
	GripWidth             = 3
	GripHeight            = 56
	RingWidth             = 3
	QuoteBar              = 2
	ImagePlaceholder      = 64
	ReaderMaxWidth        = 720
	AttachmentWidth       = 282
	DraftAttachmentWidth  = 286
	WitMaxWidth           = 760
	CitationsWidth        = 320
)

const BoldWeight = 600

var HeadingScale = [6]float32{1.6, 1.4, 1.2, 1.1, 1, 1}

const (
	IconXs, IconSm, Icon, IconMd, IconLg, IconXl     = 12, 14, 16, 18, 20, 28
	Logo                                             = 64
	AboutBird                                        = 150
	BrandLogo                                        = 48
	MarkSm, MarkMd, MarkLg, MarkXl                   = 16, 28, 40, 48
	ServiceMarkOffset                                = 4
	CloseButton                                      = 20
	LabelChip, LabelChipX, LabelChipXIcon            = 20, 16, 10
	Control                                          = 16
	RadioDot, StatusDot                              = 8, 6
	StatusBadge, StatusBadgeRing                     = 9, 1.5
	SwitchWidth, SwitchHeight, SwitchThumb           = 32, 18, 14
	SwitchInset                                      = (SwitchHeight - SwitchThumb) / 2
	StepDot, DoneBadge                               = 20, 36
	ThemeTileWidth, ThemeTileHeight, ThemeTileGap    = 76, 48, 10
	TileRail, TileSide, TileInset, TileGap, TileLine = 8, 18, 6, 4, 3
	SkeletonShort                                    = 160
	OlderRowHeight                                   = 36
	EmptyIcon, EmptyDescMax                          = 40, 400
	TabUnderline                                     = 2
	Watermark                                        = 96
	FormLabelWidth, ModelIDInputWidth                = 96, 132
	SummaryIndent, CardTracking                      = 18, 3
	SummaryDot                                       = 5
)

type ShadowLayer struct{ Y, Blur, Spread, Alpha float32 }

type Elevation []ShadowLayer

var (
	ShadowXs  = Elevation{{1, 2, 0, 0.05}}
	ShadowSm  = Elevation{{1, 3, 0, 0.1}, {1, 2, -1, 0.1}}
	ShadowMd  = Elevation{{4, 6, -1, 0.1}, {2, 4, -2, 0.1}}
	ShadowLg  = Elevation{{10, 15, -3, 0.1}, {4, 6, -4, 0.1}}
	ShadowXl  = Elevation{{20, 25, -5, 0.1}, {8, 10, -6, 0.1}}
	ShadowX2l = Elevation{{25, 50, -12, 0.25}}
)

const FloatInsetBlur = 1

var ShadowFloat = Elevation{{0, 0, 1, 0x0a / 255.0}, {2, 8, 0, 0x0a / 255.0}, {4, 80, 8, 0x06 / 255.0}}

func sized(t Tokens) Tokens {
	f := t.FontSize
	t.Radius = RadiusScale{Xs: 2, Sm: 4, Md: 6, Lg: 8, Xl: 12, X2l: 16, X3l: 24, X4l: 32, Full: 9999}
	t.Text = TextScale{Xs: f - 3, Sm: f - 2, Base: f - 1, Body: f, Lg: f + 1, Title: f + 2,
		Xl: f + 4, X2l: f + 6, Display: f + 15}
	return t
}



func status(t Tokens) Tokens {
	t.Success = p.Green600.Color()
	t.WarningBg, t.WarningBorder, t.WarningText = p.Amber50.Color(), p.Amber300.Color(), p.Amber800.Color()
	t.Danger, t.DangerBg, t.Attention, t.Unread = p.Red600.Color(), p.Red50.Color(), p.Amber500.Color(), p.Blue500.Color()
	t.SuccessBg, t.SuccessBorder, t.SuccessText = p.Green50.Color(), p.Green200.Color(), p.Green700.Color()
	t.DangerBorder, t.DangerText = p.Red200.Color(), p.Red700.Color()
	t.InsBg, t.InsText, t.DelBg, t.DelText = p.Green100.Color(), p.Green800.Color(), p.Red50.Color(), p.Red700.Color()
	t.Highlight, t.HighlightText = p.Yellow200.Color(), p.Neutral950.Color()
	if t.Dark {
		t.WarningBg, t.WarningBorder, t.WarningText = p.Amber950.Color(), p.Amber800.Color(), p.Amber300.Color()
		t.DangerBg, t.DangerBorder, t.DangerText = p.Red950.Color(), p.Red800.Color(), p.Red300.Color()
		t.SuccessBg, t.SuccessBorder, t.SuccessText = p.Green950.Color(), p.Green800.Color(), p.Green300.Color()
		t.InsBg, t.InsText, t.DelBg, t.DelText = p.Green950.Color(), p.Green300.Color(), p.Red950.Color(), p.Red300.Color()
		t.Highlight, t.HighlightText = p.Yellow900.Color(), p.Yellow100.Color()
	}
	t.FontSize, t.BodyFontSize, t.Scale = 14, 14, 1
	return sized(t)
}

func Light() Tokens {
	return status(Tokens{
		Window: p.Neutral50.Color(), Sidebar: p.Neutral50.Color(),
		Background: p.White.Color(), Foreground: p.Neutral950.Color(), Muted: p.Neutral500.Color(),
		Border: p.Neutral200.Color(), Grid: p.Neutral300.Color(), Input: p.Neutral200.Color(), Ring: p.Neutral400.Color(), Idle: p.Neutral400.Color(), Outline: p.Neutral950.Color().Alpha(0.05), DividerHover: p.Neutral300.Color(), MarkTile: p.White.Color(), OnSolid: p.White.Color(), Raised: p.White.Color(), Card: p.Neutral50.Color(), Scrim: p.Black.Color().Alpha(0.2), AlertScrim: p.MacAlertGray.Color().Alpha(0.6),
		Primary: p.Neutral900.Color(), PrimaryText: p.White.Color(),
		SidebarSelected: p.Neutral100.Color(), HoverTint: p.Neutral950.Color().Alpha(0.04),
		Hover:   p.Neutral100.Color(),
		GlassBg: p.White.Color().Alpha(0.70), GlassBorder: p.Neutral950.Color().Alpha(0.12), GlassHover: p.Neutral100.Color().Alpha(0.80),
	})
}

func Dark() Tokens {
	return status(Tokens{
		Dark:   true,
		Window: p.Mid(p.Neutral900, p.Neutral800).Color(), Sidebar: p.Neutral900.Color(),
		Background: p.Neutral950.Color(), Foreground: p.Neutral50.Color(), Muted: p.Neutral400.Color(),
		Border: p.White.Color().Alpha(0.1), Grid: p.White.Color().Alpha(0.14), Input: p.White.Color().Alpha(0.15), Ring: p.Neutral500.Color(), Idle: p.Neutral500.Color(), Outline: p.White.Color().Alpha(0.05), DividerHover: p.Neutral700.Color(), MarkTile: p.White.Color(), OnSolid: p.White.Color(), FloatInset: p.White.Color().Alpha(0.2), Raised: p.Neutral900.Color(), Card: p.Neutral900.Color(), Scrim: p.Black.Color().Alpha(0.2), AlertScrim: p.Neutral900.Color().Alpha(0.6),
		Primary: p.Neutral200.Color(), PrimaryText: p.Neutral900.Color(),
		SidebarSelected: p.Neutral800.Color(), HoverTint: p.White.Color().Alpha(0.08),
		Hover:   p.Neutral800.Color(),
		GlassBg: p.Neutral900.Color().Alpha(0.70), GlassBorder: p.White.Color().Alpha(0.15), GlassHover: p.Neutral800.Color().Alpha(0.80),
	})
}

func FromAppearance(dark bool) Tokens {
	if dark {
		return Dark()
	}
	return Light()
}

var (
	mu     sync.Mutex
	themes = map[Tokens]*ui.Theme{}
	tokens = map[*ui.Theme]Tokens{}
)

const Mono = "monospace"

func Apply(c *ui.Context, t Tokens) {
	mu.Lock()
	th, ok := themes[t]
	if !ok {
		th = mygoTheme(t)
		themes[t], tokens[th] = th, t
	}
	mu.Unlock()
	c.SetTheme(th)
}

func mygoTheme(t Tokens) *ui.Theme {
	th := *ui.LightTheme()
	if t.Dark {
		th = *ui.DarkTheme()
	}
	th.Background, th.Surface, th.SurfaceHover, th.SurfacePressed = t.Background, t.Background, t.Hover, t.Border
	th.Border, th.Text, th.TextMuted = t.Border, t.Foreground, t.Muted
	th.Accent, th.AccentText = t.Primary, t.PrimaryText
	th.AccentHover, th.AccentPressed = t.Primary.Mix(t.Background, 0.1), t.Primary.Mix(t.Background, 0.2)
	th.Danger, th.Warning, th.Success = t.Danger, t.Attention, t.Success
	th.Selection, th.Focus, th.Scrollbar = t.Primary.Alpha(0.15), t.Ring.Alpha(0.5), t.Muted.Alpha(0.5)
	th.Inverse, th.InverseText = t.Foreground, t.Background
	th.Radius, th.Spacing = t.Radius.Lg, 4*t.Scale
	th.Font, th.FontSize = "", t.Text.Body
	return &th
}

func Of(c *ui.Context) Tokens {
	th := c.Theme()
	mu.Lock()
	t, ok := tokens[th]
	mu.Unlock()
	if ok {
		return t
	}
	if th.Dark {
		return Dark()
	}
	return Light()
}

const (
	MotionFast = 120 * time.Millisecond
	MotionBase = 200 * time.Millisecond
	MotionOffset = 4

	SkeletonPulse = 1500 * time.Millisecond
)
