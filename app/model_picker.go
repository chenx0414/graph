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
	pending  *modelChoice
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
		if !c.providerAllowed(c.modelProviderOf(model)) {
			continue
		}
		if c.modelPicker.provider != "" && c.modelProviderOf(model) != c.modelPicker.provider {
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
		id := c.modelProviderOf(model)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		providers = append(providers, id)
	}
	return providers
}

func (c *chatState) currentLevel() string {
	if c.modelPicker.pending != nil {
		return c.pendingLevel()
	}
	if c.currentThinking != "" {
		return c.currentThinking
	}
	return c.pickerActiveModel().thinking
}

func (c *chatState) pendingLevel() string {
	if c.modelPicker.pending == nil {
		return ""
	}
	if c.modelPicker.pending.id == c.currentModel && c.currentThinking != "" {
		return c.currentThinking
	}
	return c.modelPicker.pending.thinking
}

func (c *chatState) pendingModel() modelChoice {
	if c.modelPicker.pending != nil {
		return *c.modelPicker.pending
	}
	return c.pickerActiveModel()
}

func (c *chatState) chooseProvider(id string) {
	c.modelPicker.provider = id
	c.modelPicker.active = 0
	c.modelPicker.pending = nil
	c.frame()
}

func (c *chatState) pickModel(model modelChoice) {
	chosen := model
	c.modelPicker.pending = &chosen
	c.frame()
}

func (c *chatState) pickLevel(level string) {
	model := c.pendingModel()
	c.modelPicker.pending = nil
	c.modelPicker.open = false
	go c.selectModel(model, level)
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

// pickerRowLabel names a model in the picker. When more than one provider serves
// the same short name the provider is part of the name: without it seven rows
// read "deepseek-v4.1-flash" and no reader can tell which one runs. When one
// provider serves the same short name under several ids, the id is the only thing
// that separates them.
func (c *chatState) pickerRowLabel(model modelChoice) string {
	name := shortModel(model.id)
	if !c.pickerDuplicate(model) {
		return name
	}
	provider := c.modelProviderOf(model)
	if provider == "" {
		return name
	}
	label := name + " · " + provider
	for _, other := range c.pickerModels() {
		if other.id != model.id && other.id != shortModel(other.id) &&
			c.modelProviderOf(other) == provider && shortModel(other.id) == name {
			return label + " · " + model.id
		}
	}
	return label
}

// modelChipLabel names the model in use, with the provider whenever the model
// list holds more than one entry carrying that short name.
func (c *chatState) modelChipLabel() string {
	if c.currentModel == "" {
		return ""
	}
	chosen := modelChoice{id: c.currentModel}
	for _, model := range c.models {
		if model.id == c.currentModel {
			chosen = model
			break
		}
	}
	name := shortModel(c.currentModel)
	if c.pickerDuplicate(chosen) {
		if provider := c.modelProviderOf(chosen); provider != "" {
			name += " · " + provider
		}
	}
	if thinking := c.currentThinking; thinking != "" {
		name = strings.TrimSpace(name + " " + thinking)
	}
	return strings.TrimSpace(name)
}

func providerMark(ctx *ui.Context, id string, size float32, t gwtheme.Tokens) {
	if icon := providerBrandIcon(id); icon != nil {
		ui.Icon(ctx, icon).Size(size, size).TextColor(t.Foreground)
		return
	}
	tint := providerTint(id)
	ui.Box(ctx).Size(size, size).Radius(t.Radius.Xs).Background(tint.Alpha(0.16)).Center().Children(func() {
		kit.Text(ctx, providerInitial(id), 9).FontWeight(600).TextColor(tint)
	})
}

func (c *chatState) pickerRow(ctx *ui.Context, model modelChoice, index int, t gwtheme.Tokens) {
	row := ui.Row(ctx).FillWidth().Height(34).PaddingX(12).Gap(8).AlignItems(ui.Center).Role(ui.RoleOption).
		Label(c.pickerRowLabel(model)).AccessSelected(model.id == c.pendingModel().id)
	active := model.id == c.pickerActiveModel().id
	if active {
		row.Background(t.Hover)
	}
	row.OnClick(func() { c.pickModel(model) })
	row.Children(func() {
		providerMark(ctx, c.modelProviderOf(model), 16, t)
		label := ui.Row(ctx).Grow(1).Gap(6).AlignItems(ui.Center)
		label.Children(func() {
			kit.Text(ctx, shortModel(model.id), t.Text.Xs).FontWeight(500).TextColor(t.Foreground).SingleLine().Ellipsis("…")
			if c.pickerDuplicate(model) {
				kit.Text(ctx, "· "+c.modelProviderOf(model), t.Text.Xs).TextColor(t.Muted).SingleLine().Ellipsis("…")
			}
		})
		if model.id == c.pendingModel().id {
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
	model := c.pendingModel()
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
				row := ui.Row(ctx).FillWidth().Height(34).PaddingX(12).Gap(8).AlignItems(ui.Center).
					Role(ui.RoleOption).Label("理由 " + reasoningLabel(value)).AccessSelected(value == c.currentLevel())
				row.OnClick(func() { c.pickLevel(value) })
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
	c.pickModel(model)
	c.pickLevel(c.pendingLevel())
}

func (c *chatState) modelPickerOverlay(ctx *ui.Context, anchor ui.Element) {
	if !c.modelPicker.open {
		return
	}
	th := ctx.Theme()
	ui.Overlay(ctx, func() {
		backdrop := ui.Box(ctx).Absolute().Left(0).Top(0).Right(0).Bottom(0)
		backdrop.OnClick(func() { c.closeModelPicker() })
		panel := c.modelPickerView(ctx)
		panel.AttachTo(anchor, ui.AnchorTopRight, ui.AnchorBottomRight).Margin(0, 0, th.Space(1.5), 0)
		if panel.OverlayShortcut(0, ui.KeyEscape) {
			c.closeModelPicker()
		}
	})
}

func (c *chatState) closeModelPicker() {
	c.modelPicker.open = false
	c.modelPicker.pending = nil
	c.frame()
}

func (c *chatState) modelPickerView(ctx *ui.Context) ui.Element {
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
				c.chooseProvider("")
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
					c.chooseProvider(id)
				})
				button.Children(func() {
					providerMark(ctx, id, 16, t)
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
							c.pickModel(models[c.modelPicker.active])
						}
						return true
					}
					return false
				})
			})
			ui.Box(ctx).FillWidth().Height(gwtheme.Stroke).Background(t.Border)
		})
		list.Children(func() {
			if len(c.models) == 0 {
				c.pickerEmptyState(ctx, t)
				return
			}
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
	return panel
}

func (c *chatState) pickerEmptyState(ctx *ui.Context, t gwtheme.Tokens) {
	th := ctx.Theme()
	ui.Column(ctx).Grow(1).FillWidth().Center().Gap(th.Space(1.5)).Children(func() {
		kit.Text(ctx, "还没有可用的模型", t.Text.Sm).TextColor(t.Foreground)
		kit.Text(ctx, "这份安装没有配置任何供应商凭据，模型列表是空的。", t.Text.Xs).TextColor(t.Muted)
		if kit.Button(ctx, "去供应商页添加", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
			c.modelPicker.open = false
			c.frame()
			if c.openProviders != nil {
				c.openProviders()
			}
		}
	})
}
