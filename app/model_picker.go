package main

import (
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type modelPickerState struct {
	open     bool
	query    string
	active   int
	provider string
	showAll  bool
	focus    bool
}

var pickerShortcutKeys = []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4}

func reasoningLabel(level string) string {
	if level == "" {
		return "Default"
	}
	return strings.ToUpper(level[:1]) + level[1:]
}

func (c *chatState) providerAllowed(id string) bool {
	if c.providerOn == nil {
		return true
	}
	return c.providerOn(id)
}

func (c *chatState) pickerModels() []modelChoice {
	query := strings.ToLower(strings.TrimSpace(c.modelPicker.query))
	models := make([]modelChoice, 0, len(c.models))
	for _, model := range c.models {
		if !c.providerAllowed(modelProviderID(model.id)) {
			continue
		}
		if c.modelPicker.provider != "" && modelProviderID(model.id) != c.modelPicker.provider {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(model.id), query) {
			continue
		}
		models = append(models, model)
	}
	return models
}

func (c *chatState) pickerProviders() []string {
	seen := map[string]bool{}
	providers := []string{}
	for _, model := range c.models {
		id := modelProviderID(model.id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		providers = append(providers, id)
	}
	return providers
}

func (c *chatState) currentLevel() string {
	if c.currentThinking != "" {
		return c.currentThinking
	}
	return c.pickerActiveModel().thinking
}

func (c *chatState) pickerActiveModel() modelChoice {
	models := c.pickerModels()
	for _, model := range models {
		if model.id == c.currentModel {
			return model
		}
	}
	if c.modelPicker.active >= 0 && c.modelPicker.active < len(models) {
		return models[c.modelPicker.active]
	}
	if len(models) > 0 {
		return models[0]
	}
	return modelChoice{}
}

func (c *chatState) pickerDuplicate(model modelChoice) bool {
	name := shortModel(model.id)
	for _, other := range c.models {
		if other.id != model.id && shortModel(other.id) == name {
			return true
		}
	}
	return false
}

func (c *chatState) pickerRow(ctx *ui.Context, model modelChoice, index int, t gwtheme.Tokens) {
	row := ui.Row(ctx).FillWidth().Height(34).PaddingX(12).Gap(8).AlignItems(ui.Center).Label(shortModel(model.id))
	active := model.id == c.pickerActiveModel().id
	if active {
		row.Background(t.Hover)
	}
	row.OnClick(func() { c.chooseModel(model) })
	row.Children(func() {
		tint := providerTint(modelProviderID(model.id))
		tile := ui.Box(ctx).Size(16, 16).Radius(t.Radius.Xs).Background(tint.Alpha(0.16)).Center()
		tile.Children(func() {
			kit.Text(ctx, providerInitial(modelProviderID(model.id)), 9).FontWeight(600).TextColor(tint)
		})
		label := ui.Row(ctx).Grow(1).Gap(6).AlignItems(ui.Center)
		label.Children(func() {
			kit.Text(ctx, shortModel(model.id), t.Text.Xs).FontWeight(500).TextColor(t.Foreground).SingleLine().Ellipsis("…")
			if c.pickerDuplicate(model) {
				kit.Text(ctx, modelProviderID(model.id), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			}
		})
		if model.id == c.currentModel {
			ui.Icon(ctx, iconCheck).Size(14, 14).TextColor(t.Foreground)
		}
		if index < 4 {
			chip := ui.Row(ctx).Height(18).PaddingX(6).Radius(t.Radius.Xs).Background(t.Hover).AlignItems(ui.Center)
			chip.Children(func() {
				kit.Text(ctx, "⌘"+strconv.Itoa(index+1), t.Text.Xs).TextColor(t.Muted).SingleLine()
			})
		}
	})
}

func (c *chatState) pickerReasoning(ctx *ui.Context, t gwtheme.Tokens) {
	model := c.pickerActiveModel()
	ui.Column(ctx).Width(192).FillHeight().Children(func() {
		head := ui.Row(ctx).FillWidth().Height(48).PaddingX(12).Gap(8).AlignItems(ui.Center)
		head.Children(func() {
			kit.Text(ctx, "Reasoning", t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine()
			kit.Text(ctx, reasoningLabel(c.currentLevel()), t.Text.Xs).TextColor(t.Muted).SingleLine()
		})
		ui.Box(ctx).FillWidth().Height(gwtheme.Stroke).Background(t.Border)
		ui.Scroll(ctx).Grow(1).Children(func() {
			levels := thinkingLevels(model)
			for _, level := range levels {
				value := level
				row := ui.Row(ctx).FillWidth().Height(34).PaddingX(12).Gap(8).AlignItems(ui.Center).Label("理由 " + reasoningLabel(value))
				row.OnClick(func() {
					go c.selectModel(model, value)
				})
				row.Children(func() {
					kit.Text(ctx, reasoningLabel(value), t.Text.Xs).TextColor(t.Foreground).Grow(1).SingleLine()
					if value == c.currentLevel() {
						ui.Icon(ctx, iconCheck).Size(14, 14).TextColor(t.Foreground)
					}
				})
			}
		})
	})
}

func (c *chatState) chooseModel(model modelChoice) {
	level := model.thinking
	if model.id == c.currentModel && c.currentThinking != "" {
		level = c.currentThinking
	}
	c.modelPicker.open = false
	go c.selectModel(model, level)
}

func (c *chatState) modelPickerView(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	c.loadModels()
	panel := ui.Row(ctx).Width(530).Height(346).Radius(t.Radius.Xl).Border(gwtheme.Hairline, t.Border).
		Background(t.Card).Clip().Label("模型选择器")
	kit.Elevate(ctx, panel, composerShadow)
	for index, key := range pickerShortcutKeys {
		models := c.pickerModels()
		if index >= len(models) {
			break
		}
		model := models[index]
		panel.OnShortcut(ui.Cmd, key, func() {
			c.chooseModel(model)
			c.frame()
		})
	}
	panel.Children(func() {
		rail := ui.Column(ctx).Width(44).FillHeight().PaddingY(8).Gap(6).AlignItems(ui.Center).Background(t.Raised)
		rail.Children(func() {
			allButton := ui.Box(ctx).Size(28, 28).Radius(t.Radius.Sm).Center().Label("全部供应商")
			if c.modelPicker.provider == "" {
				allButton.Background(t.Hover)
			}
			allButton.OnClick(func() {
				c.modelPicker.provider = ""
				c.modelPicker.active = 0
				c.frame()
			})
			allButton.Children(func() {
				kit.Text(ctx, "全", t.Text.Xs).TextColor(t.Muted)
			})
			for _, provider := range c.pickerProviders() {
				id := provider
				button := ui.Box(ctx).Size(28, 28).Radius(t.Radius.Sm).Center().Label("过滤 " + id)
				if c.modelPicker.provider == id {
					button.Background(t.Hover)
				}
				button.OnClick(func() {
					c.modelPicker.provider = id
					c.modelPicker.active = 0
					c.frame()
				})
				button.Children(func() {
					tint := providerTint(id)
					ui.Box(ctx).Size(16, 16).Radius(t.Radius.Xs).Background(tint.Alpha(0.18)).Center().Children(func() {
						kit.Text(ctx, providerInitial(id), 9).FontWeight(600).TextColor(tint)
					})
				})
			}
		})
		ui.Box(ctx).Width(gwtheme.Stroke).FillHeight().Background(t.Border)
		list := ui.Column(ctx).Grow(1).FillHeight()
		list.Children(func() {
			search := ui.Row(ctx).FillWidth().Height(48).PaddingX(12).AlignItems(ui.Center)
			search.Children(func() {
				field := kit.Input(ctx, &c.modelPicker.query, kit.InputOpts{Bare: true, Placeholder: "Search models..."})
				field.FillWidth()
				if c.modelPicker.focus {
					field.Focus()
					c.modelPicker.focus = false
				}
				field.OnTextKey(func(k ui.TextKey) bool {
					switch k.Key {
					case ui.KeyEscape:
						c.modelPicker.open = false
						c.frame()
						return true
					case ui.KeyDown:
						c.modelPicker.active++
						c.frame()
						return true
					case ui.KeyUp:
						c.modelPicker.active--
						if c.modelPicker.active < 0 {
							c.modelPicker.active = 0
						}
						c.frame()
						return true
					case ui.KeyEnter:
						models := c.pickerModels()
						if c.modelPicker.active >= 0 && c.modelPicker.active < len(models) {
							chosen := models[c.modelPicker.active]
							c.modelPicker.open = false
							go c.selectModel(chosen, chosen.thinking)
						}
						return true
					}
					return false
				})
			})
			ui.Box(ctx).FillWidth().Height(gwtheme.Stroke).Background(t.Border)
		})
		list.Children(func() {
			ui.Scroll(ctx).Grow(1).Children(func() {
				models := c.pickerModels()
				visible := models
				if !c.modelPicker.showAll && len(visible) > 4 {
					visible = visible[:4]
				}
				for index, model := range visible {
					c.pickerRow(ctx, model, index, t)
				}
				if !c.modelPicker.showAll && len(models) > 4 {
					more := ui.Row(ctx).FillWidth().Height(34).PaddingX(12).AlignItems(ui.Center).Label("Show more")
					more.OnClick(func() {
						c.modelPicker.showAll = true
						c.frame()
					})
					more.Children(func() {
						kit.Text(ctx, "Show more", t.Text.Xs).TextColor(t.Muted).SingleLine()
					})
				}
			})
		})
		ui.Box(ctx).Width(gwtheme.Stroke).FillHeight().Background(t.Border)
		c.pickerReasoning(ctx, t)
	})
}
