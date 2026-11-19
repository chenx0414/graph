package main

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type platformPreset struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	API            string   `json:"api"`
	BaseURL        string   `json:"baseUrl"`
	CredentialRef  string   `json:"credentialRef"`
	CredentialKind string   `json:"credentialKind"`
	Custom         bool     `json:"custom"`
	Notes          []string `json:"notes"`
}

type nativeProviderRow struct {
	ID         string
	Label      string
	Platform   string
	BaseURL    string
	Models     []string
	Configured bool
}

type providerDraft struct {
	Platform string
	Name     string
	BaseURL  string
	APIKey   string
	Models   string
}

type platformCatalogPayload struct {
	Platforms []platformPreset `json:"platforms"`
}

func parseNativeProviders(payload []byte) ([]nativeProviderRow, map[string]any, int, error) {
	var envelope struct {
		Revision int            `json:"revision"`
		Config   map[string]any `json:"config"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, nil, 0, err
	}
	document := envelope.Config
	credentials, _ := document["credentials"].(map[string]any)
	models, _ := document["models"].(map[string]any)
	entries, _ := models["entries"].([]any)
	byProvider := map[string]*nativeProviderRow{}
	order := []string{}
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		provider := strings.TrimSpace(stringValue(entry["provider"]))
		credentialID := strings.TrimSpace(stringValue(entry["credentialId"]))
		key := credentialID
		if key == "" {
			key = provider
		}
		if key == "" {
			continue
		}
		row, known := byProvider[key]
		if !known {
			row = &nativeProviderRow{ID: key, Label: key, Platform: provider, BaseURL: strings.TrimSpace(stringValue(entry["baseUrl"]))}
			byProvider[key] = row
			order = append(order, key)
		}
		if id := strings.TrimSpace(stringValue(entry["id"])); id != "" {
			row.Models = append(row.Models, id)
		}
		if row.BaseURL == "" {
			row.BaseURL = strings.TrimSpace(stringValue(entry["baseUrl"]))
		}
	}
	rows := make([]nativeProviderRow, 0, len(order))
	for _, key := range order {
		row := *byProvider[key]
		if credential, ok := credentials[key].(map[string]any); ok {
			row.Configured, _ = credential["configured"].(bool)
			if platform := strings.TrimSpace(stringValue(credential["platform"])); platform != "" {
				row.Platform = platform
			}
			if name := strings.TrimSpace(stringValue(credential["displayName"])); name != "" {
				row.Label = name
			}
		}
		if len(row.Models) == 0 {
			continue
		}
		rows = append(rows, row)
	}
	return rows, document, envelope.Revision, nil
}

func stringValue(raw any) string {
	text, _ := raw.(string)
	return text
}

func (s *shellState) platformLabel(id string) string {
	for _, preset := range s.providers.platforms {
		if preset.ID == id {
			return preset.Label
		}
	}
	return id
}

func (s *shellState) ensureProviders() {
	if s.providers.loading || s.providers.attempted {
		return
	}
	s.loadProviders()
}

func (s *shellState) loadProviders() {
	if s.providers.loading {
		return
	}
	s.providers.loading = true
	api := s.api
	if s.providers.appToken == "" {
		s.providers.appToken = appToken(s.stateDir)
	}
	if s.providers.secretsFile == "" {
		s.providers.secretsFile = secretsPath(s.stateDir)
	}
	go func() {
		nativeRows, document, revision, nativeErr := s.fetchNativeProviders(api)
		payload, magpieErr := api.get("/api/providers/magpie")
		var entries []providerEntry
		var enabled map[string]bool
		var source magpieProvidersPayload
		if magpieErr == nil {
			entries, enabled, source, magpieErr = parseMagpieProviders(payload)
			if magpieErr == nil && !source.Available && source.Error != "" {
				magpieErr = errStatus(source.Error)
			}
		}
		onUI(s.window, func() {
			s.providers.loading = false
			s.providers.attempted = true
			s.providers.native = nativeRows
			if nativeErr == nil {
				s.providers.document = document
				s.providers.revision = revision
				s.providers.nativeFailed = ""
			} else {
				s.providers.nativeFailed = nativeErr.Error()
			}
			if magpieErr != nil {
				s.providers.failed = magpieErr.Error()
				s.providers.source = source
			} else {
				s.providers.failed = ""
				s.providers.entries = entries
				s.providers.enabled = enabled
				s.providers.source = source
			}
			s.frame()
		})
	}()
}

func (s *shellState) fetchNativeProviders(api apiClient) ([]nativeProviderRow, map[string]any, int, error) {
	configPayload, err := api.get("/api/config")
	if err != nil {
		if isNotFound(err) {
			return nil, nil, 0, nil
		}
		return nil, nil, 0, err
	}
	rows, document, revision, err := parseNativeProviders(configPayload)
	if err != nil {
		return nil, nil, 0, err
	}
	if catalogPayload, catalogErr := api.get("/api/providers"); catalogErr == nil {
		var catalog platformCatalogPayload
		if json.Unmarshal(catalogPayload, &catalog) == nil {
			s.providers.platforms = catalog.Platforms
		}
	}
	return rows, document, revision, nil
}

func (s *shellState) nativeProviderModel(id string) *nativeProviderRow {
	for index := range s.providers.native {
		if s.providers.native[index].ID == id {
			return &s.providers.native[index]
		}
	}
	return nil
}

func (s *shellState) openProviderPicker(id string) {
	active := s.active()
	if active == nil {
		return
	}
	active.modelPicker.provider = id
	active.modelPicker.open = true
	active.modelPicker.active = 0
	active.modelPicker.showAll = false
	active.modelPicker.focus = true
	s.frame()
}

func (s *shellState) addProviderDraft() {
	platform := "openai"
	baseURL := ""
	for _, preset := range s.providers.platforms {
		if preset.ID == platform {
			baseURL = preset.BaseURL
		}
	}
	s.providers.draft = providerDraft{Platform: platform, BaseURL: baseURL}
	s.providers.addOpen = true
	s.providers.saveFailed = ""
	s.frame()
}

func (s *shellState) saveProvider() {
	if s.providers.saving {
		return
	}
	name := strings.TrimSpace(s.providers.draft.Name)
	baseURL := strings.TrimSpace(s.providers.draft.BaseURL)
	key := strings.TrimSpace(s.providers.draft.APIKey)
	models := splitModelList(s.providers.draft.Models)
	if name == "" || baseURL == "" || len(models) == 0 {
		s.providers.saveFailed = "名称、接口地址和模型列表都要填"
		s.frame()
		return
	}
	document := cloneDocument(s.providers.document)
	if document == nil {
		s.providers.saveFailed = "读不到配置，暂时加不了供应商"
		s.frame()
		return
	}
	platform := s.providers.draft.Platform
	if platform == "" {
		platform = "custom"
	}
	preset := platformPreset{ID: platform, API: "openai-completions"}
	for _, candidate := range s.providers.platforms {
		if candidate.ID == platform {
			preset = candidate
			break
		}
	}
	api := preset.API
	if api == "" {
		api = "openai-completions"
	}
	credentialID := slugProviderID(name)
	secretRef := "GRAPH_PROVIDER_" + strings.ToUpper(strings.ReplaceAll(credentialID, "-", "_")) + "_API_KEY"
	credentials, _ := document["credentials"].(map[string]any)
	if credentials == nil {
		credentials = map[string]any{}
		document["credentials"] = credentials
	}
	credentials[credentialID] = map[string]any{"secretRef": secretRef, "platform": platform, "displayName": name}
	modelsDoc, _ := document["models"].(map[string]any)
	if modelsDoc == nil {
		modelsDoc = map[string]any{"entries": []any{}}
		document["models"] = modelsDoc
	}
	entries, _ := modelsDoc["entries"].([]any)
	for _, modelID := range models {
		entries = append(entries, map[string]any{
			"id": modelID, "provider": credentialID, "api": api, "baseUrl": baseURL,
			"contextWindow": 128000, "maxTokens": 8192, "credentialId": credentialID,
		})
	}
	modelsDoc["entries"] = entries
	s.providers.saving = true
	s.providers.saveFailed = ""
	apiClient, appToken := s.api, s.providers.appToken
	revision, secretsFile := s.providers.revision, s.providers.secretsFile
	go func() {
		body := map[string]any{"expectedRevision": revision, "document": document}
		_, err := apiClient.post("/api/config", body)
		if err == nil && key != "" {
			_, err = apiClient.postApp("/api/app/secret", appToken, map[string]any{"ref": secretRef, "value": key, "persisted": true})
			if err == nil && secretsFile != "" {
				err = saveSecret(secretsFile, secretRef, &key)
			}
		}
		onUI(s.window, func() {
			s.providers.saving = false
			if err != nil {
				s.providers.saveFailed = "保存失败：" + err.Error()
				s.frame()
				return
			}
			s.providers.addOpen = false
			s.providers.draft = providerDraft{}
			s.refreshProviders()
			s.dropCachedModels()
			s.frame()
		})
	}()
}

func splitModelList(value string) []string {
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == '\n' || r == '，' || r == ' ' || r == '\t'
	})
	models := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		model := strings.TrimSpace(field)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		models = append(models, model)
	}
	return models
}

func slugProviderID(name string) string {
	var builder strings.Builder
	previousDash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			builder.WriteRune(r)
			previousDash = false
		case r == '-' || r == '_' || r == ' ':
			if !previousDash && builder.Len() > 0 {
				builder.WriteRune('-')
				previousDash = true
			}
		}
	}
	id := strings.Trim(builder.String(), "-")
	if id == "" {
		return "provider"
	}
	return id
}

func cloneDocument(document map[string]any) map[string]any {
	if document == nil {
		return nil
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return nil
	}
	var clone map[string]any
	if err := json.Unmarshal(payload, &clone); err != nil {
		return nil
	}
	return clone
}

func (s *shellState) nativeProviderRow(ctx *ui.Context, row nativeProviderRow, pal magpiePalette, last bool) {
	label := "用 " + row.Label + " 的模型"
	element := ui.Row(ctx).FillWidth().Height(48).Padding(7, 12, 7, 14).Gap(12).AlignItems(ui.Center).
		Label(label).Focusable()
	if element.Hovered() {
		element.Background(pal.Card2)
	}
	element.OnClick(func() { s.openProviderPicker(row.ID) })
	element.Children(func() {
		handle := ui.Box(ctx).Size(28, 28).Radius(6).Center()
		if icon := providerBrandIcon(row.ID); icon != nil {
			handle.Children(func() {
				ui.Icon(ctx, icon).Size(22, 22).TextColor(pal.Foreground)
			})
		} else {
			tint := providerTint(row.ID)
			handle.Background(tint.Alpha(0.14))
			handle.Children(func() {
				kit.Text(ctx, providerInitial(row.Label), 12).FontWeight(600).TextColor(tint)
			})
		}
		ui.Column(ctx).Grow(1).Gap(1).Children(func() {
			ui.Row(ctx).Gap(6).AlignItems(ui.Center).Children(func() {
				kit.Text(ctx, row.Label, 13).FontWeight(500).LetterSpacing(-0.06).TextColor(pal.Foreground).
					SingleLine().Ellipsis("…")
				badge := ui.Row(ctx).PaddingX(5).PaddingY(1).Radius(4).Background(pal.Pill).AlignItems(ui.Center)
				badge.Children(func() {
					kit.Text(ctx, s.platformLabel(row.Platform), 9.5).FontWeight(600).LetterSpacing(0.2).TextColor(pal.Muted).SingleLine()
				})
			})
			kit.Text(ctx, row.BaseURL+" · "+strconv.Itoa(len(row.Models))+" 个模型", 11.5).TextColor(pal.Muted).SingleLine().Ellipsis("…")
		})
		state := "已配置"
		dot, text := pal.Green, pal.Mark
		if !row.Configured {
			state = "未配置"
			dot, text = pal.Amber, pal.Amber
		}
		pill := ui.Row(ctx).Width(96).Height(22).Radius(6).PaddingX(8).Gap(6).AlignItems(ui.Center)
		pill.Children(func() {
			ui.Box(ctx).Width(6).Height(6).Radius(10).Background(dot)
			kit.Text(ctx, state, 11).TextColor(text).SingleLine()
		})
		ui.Icon(ctx, iconChevron).Size(11, 11).TextColor(pal.Faint)
	})
	if !last {
		ui.Box(ctx).FillWidth().Height(1).Background(pal.Line2)
	}
}

func (s *shellState) nativeProvidersCard(ctx *ui.Context, pal magpiePalette) {
	card := ui.Column(ctx).FillWidth().Background(pal.Card).Radius(12).
		Border(gwtheme.Stroke, pal.Line).Clip()
	card.Children(func() {
		if len(s.providers.native) == 0 {
			kit.Text(ctx, "还没有本机供应商。点右上角「添加供应商」开始。", 13).TextColor(pal.Muted).Padding(18, 2)
			return
		}
		for index, row := range s.providers.native {
			s.nativeProviderRow(ctx, row, pal, index == len(s.providers.native)-1)
		}
	})
}

func (s *shellState) addProviderForm(ctx *ui.Context, pal magpiePalette) {
	card := ui.Column(ctx).FillWidth().Gap(10).Padding(14).Background(pal.Card2).Radius(12).
		Border(gwtheme.Stroke, pal.Line)
	card.Children(func() {
		ui.Row(ctx).FillWidth().AlignItems(ui.Center).Children(func() {
			kit.Text(ctx, "添加供应商", 13).FontWeight(600).TextColor(pal.Foreground).Grow(1)
			if kit.Button(ctx, "取消", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				s.providers.addOpen = false
				s.frame()
			}
			if kit.Button(ctx, "保存供应商", kit.ButtonOpts{Variant: kit.Default, Size: kit.SizeSm}).Clicked() {
				go s.saveProvider()
			}
		})
		kit.Text(ctx, "平台", 11).TextColor(pal.Muted)
		ui.Row(ctx).FillWidth().Wrap().Gap(6).Children(func() {
			for _, preset := range s.providers.platforms {
				if preset.CredentialKind != "" && preset.CredentialKind != "api-key" {
					continue
				}
				selected := s.providers.draft.Platform == preset.ID
				chip := kit.Button(ctx, preset.Label, kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm})
				if selected {
					chip.Background(pal.Pill)
				}
				if chip.Clicked() {
					s.providers.draft.Platform = preset.ID
					if preset.BaseURL != "" {
						s.providers.draft.BaseURL = preset.BaseURL
					}
					s.frame()
				}
			}
		})
		name := kit.Input(ctx, &s.providers.draft.Name, kit.InputOpts{Placeholder: "供应商名称"})
		name.FillWidth().Label("供应商名称")
		baseURL := kit.Input(ctx, &s.providers.draft.BaseURL, kit.InputOpts{Placeholder: "接口地址，例如 https://api.openai.com/v1"})
		baseURL.FillWidth().Label("接口地址")
		key := kit.Input(ctx, &s.providers.draft.APIKey, kit.InputOpts{Placeholder: "API Key", Password: true})
		key.FillWidth().Label("API Key")
		models := kit.Input(ctx, &s.providers.draft.Models, kit.InputOpts{Placeholder: "模型 id，用逗号分隔"})
		models.FillWidth().Label("模型列表")
		if s.providers.saveFailed != "" {
			kit.Text(ctx, s.providers.saveFailed, 12).TextColor(pal.Amber)
		}
		kit.Text(ctx, "模型 id 原样发给该平台；上下文窗口与最大输出按 128k / 8k 写入，可在配置里改。", 11).TextColor(pal.Faint)
	})
}
