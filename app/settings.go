package main

import (
	"encoding/json"
	"strconv"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type projectRow struct {
	id       string
	state    string
	archived bool
}

type settingsSnapshot struct {
	autoUpdate   bool
	document     json.RawMessage
	mode         string
	branch       string
	commit       string
	defaultModel string
	revision     int
	modelCount   int
	projects     []projectRow
}

type startupPayload struct {
	Mode         string `json:"mode"`
	ModelCount   int    `json:"modelCount"`
	EffectiveRev int    `json:"effectiveRevision"`
	Source       struct {
		Branch string `json:"branch"`
		Commit string `json:"commit"`
	} `json:"source"`
}

type configEnvelope struct {
	Revision int             `json:"revision"`
	Config   json.RawMessage `json:"config"`
}

type settingsPayload struct {
	DefaultModel string `json:"defaultModel"`
	Projects     []struct {
		ID          string `json:"id"`
		ArchivedAt  *int64 `json:"archivedAt"`
		Preparation *struct {
			State string `json:"state"`
		} `json:"preparation"`
	} `json:"projects"`
}

func parseSettings(startup, settings []byte) (settingsSnapshot, error) {
	snapshot := settingsSnapshot{}
	var began startupPayload
	if err := json.Unmarshal(startup, &began); err != nil {
		return snapshot, err
	}
	snapshot.mode = began.Mode
	snapshot.modelCount = began.ModelCount
	snapshot.branch = began.Source.Branch
	snapshot.commit = began.Source.Commit
	snapshot.revision = began.EffectiveRev
	var shaped settingsPayload
	if err := json.Unmarshal(settings, &shaped); err != nil {
		return snapshot, err
	}
	snapshot.defaultModel = shaped.DefaultModel
	for _, project := range shaped.Projects {
		state := "未准备"
		if project.Preparation != nil && project.Preparation.State != "" {
			state = project.Preparation.State
		}
		snapshot.projects = append(snapshot.projects, projectRow{id: project.ID, state: state, archived: project.ArchivedAt != nil})
	}
	return snapshot, nil
}

func shortCommit(commit string) string {
	if len(commit) > 8 {
		return commit[:8]
	}
	return commit
}

func projectLabel(row projectRow) string {
	label := row.id + " · " + row.state
	if row.archived {
		label += " · 已归档"
	}
	return label
}

type settingsState struct {
	api           apiClient
	status        string
	window        *mygo.Window
	rows          settingsSnapshot
	list          ui.ListState
	openProviders func()
	document      json.RawMessage
	revision      int
	autoUpdate    bool
}

func newSettingsState(address, token string) *settingsState {
	return &settingsState{api: newAPIClient(address, token), status: "正在读取设置…"}
}

func (s *settingsState) load() {
	startup, err := s.api.get("/api/startup")
	if err != nil {
		s.status = "读不到运行信息：" + err.Error()
		return
	}
	settings, err := s.api.get("/api/settings")
	if err != nil {
		s.status = "读不到设置：" + err.Error()
		return
	}
	snapshot, err := parseSettings(startup, settings)
	if err != nil {
		s.status = "设置不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = snapshot
	if payload, err := s.api.get("/api/config"); err == nil {
		var envelope configEnvelope
		if json.Unmarshal(payload, &envelope) == nil && len(envelope.Config) > 0 {
			var shaped map[string]any
			if json.Unmarshal(envelope.Config, &shaped) == nil {
				s.document = envelope.Config
				s.revision = envelope.Revision
				s.autoUpdate, _ = shaped["piExtensionAutoUpdate"].(bool)
				s.rows.autoUpdate = s.autoUpdate
			}
		}
	}
	s.status = ""
	s.frame()
}

func (s *settingsState) toggleAutoUpdate() {
	if len(s.document) == 0 {
		s.status = "读不到配置，暂时改不了这个开关"
		s.frame()
		return
	}
	var shaped map[string]any
	if err := json.Unmarshal(s.document, &shaped); err != nil {
		s.status = "配置不是预期结构：" + err.Error()
		s.frame()
		return
	}
	shaped["piExtensionAutoUpdate"] = !s.autoUpdate
	body := map[string]any{"expectedRevision": s.revision, "document": shaped}
	if _, err := s.api.post("/api/config", body); err != nil {
		s.status = "写入被拒绝：" + err.Error() + "（配置可能已被别处改过，重进设置页会重读）"
		s.frame()
		return
	}
	s.status = ""
	s.load()
}

func (s *settingsState) post(path string) {
	if _, err := s.api.post(path, nil); err != nil {
		s.status = "操作失败：" + err.Error()
		return
	}
	s.status = ""
	s.load()
}

func (s *settingsState) toggleProject(row projectRow) {
	action := "archive"
	if row.archived {
		action = "restore"
	}
	s.post("/api/projects/" + row.id + "/" + action)
}

func (s *settingsState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}

func (s *settingsState) view(ctx *ui.Context) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	if skeletonLoadingStatus(s.status) {
		ui.Column(ctx).FillWidth().MaxWidth(760).AlignSelf(ui.Center).Padding(th.Space(4), th.Space(6)).Children(func() {
			skeletonSettingsPage(ctx)
		})
		return
	}
	ui.Column(ctx).FillWidth().Children(func() {
		ui.Column(ctx).FillWidth().MaxWidth(760).AlignSelf(ui.Center).Gap(th.Space(8)).Children(func() {
			if s.status != "" {
				kit.Text(ctx, s.status, t.Text.Sm).TextColor(t.Muted)
			}
			s.pageHeading(ctx, "运行设置", "运行状态、源码版本与项目归档")
			rows := []func(){
				func() {
					s.settingRow(ctx, "运行模式", "这个 daemon 负责的事", func() { s.settingValue(ctx, s.rows.mode) })
				},
				func() {
					s.settingRow(ctx, "配置版本", "生效中的配置 revision", func() { s.settingValue(ctx, strconv.Itoa(s.rows.revision)) })
				},
				func() {
					s.settingRow(ctx, "源码", "正在运行的构建", func() {
						s.settingValue(ctx, s.rows.branch+"@"+shortCommit(s.rows.commit))
					})
				},
				func() {
					s.settingRow(ctx, "可用模型", "已启用的模型数量", func() { s.settingValue(ctx, strconv.Itoa(s.rows.modelCount)+" 个") })
				},
			}
			if s.rows.defaultModel != "" {
				rows = append(rows, func() {
					s.settingRow(ctx, "默认模型", "新会话从这里开始", func() {
						kit.Text(ctx, shortModel(s.rows.defaultModel), t.Text.Sm).Font(gwtheme.MonoFont).
							TextColor(t.Muted).SingleLine().Ellipsis("…")
					})
				})
			}
			rows = append(rows, func() {
				s.settingRow(ctx, "扩展自动更新", "Pi 扩展有新版本时自动更新", func() {
					s.autoUpdateSwitch(ctx)
				})
			})
			s.settingsSection(ctx, "运行", "", rows...)
			if len(s.rows.projects) > 0 {
				projects := make([]func(), 0, len(s.rows.projects))
				for _, row := range s.rows.projects {
					project := row
					desc := project.state
					if project.archived {
						desc += " · 已归档"
					}
					projects = append(projects, func() {
						s.settingRow(ctx, project.id, desc, func() {
							action := "归档 " + project.id
							if project.archived {
								action = "恢复 " + project.id
							}
							if kit.Button(ctx, action, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
								go s.toggleProject(project)
							}
						})
					})
				}
				s.settingsSection(ctx, "项目", "归档的项目不再出现在会话列表里", projects...)
			}
			kit.Text(ctx, "凭据在「供应商」页管理 · 与 magpie 同一套", t.Text.Sm).TextColor(t.Muted).PaddingX(th.Space(4))
		})
	})
}

func (s *settingsState) pageHeading(ctx *ui.Context, title, sub string) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(4)).AlignItems(ui.End).Children(func() {
		ui.Column(ctx).Grow(1).Shrink(1).Gap(6).Children(func() {
			kit.Text(ctx, title, t.Text.Display).FontWeight(600)
			if sub != "" {
				kit.Text(ctx, sub, t.Text.Body).TextColor(t.Muted)
			}
		})
		if kit.Button(ctx, "管理供应商", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
			s.openProviders()
		}
	})
}

func (s *settingsState) settingsSection(ctx *ui.Context, title, footnote string, rows ...func()) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Column(ctx).Gap(th.Space(2.5)).Children(func() {
		kit.Text(ctx, title, t.Text.Body).FontWeight(600).PaddingX(th.Space(4))
		body := ui.Column(ctx).FillWidth().Background(t.Card).Radius(t.Radius.Xl).
			Border(gwtheme.Hairline, t.Border).Clip()
		body.Children(func() {
			for index, row := range rows {
				if index > 0 {
					kit.Separator(ctx, false).Shrink(0).MarginX(th.Space(4))
				}
				row()
			}
		})
		if footnote != "" {
			kit.Text(ctx, footnote, t.Text.Sm).TextColor(t.Muted).PaddingX(th.Space(4))
		}
	})
}

func (s *settingsState) settingRow(ctx *ui.Context, label, desc string, control func()) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Row(ctx).FillWidth().Gap(th.Space(6)).Padding(th.Space(2), th.Space(4)).
		MinHeight(th.Space(12)).AlignItems(ui.Center).Children(func() {
		ui.Column(ctx).Grow(1).Shrink(1).Gap(th.Space(0.5)).Children(func() {
			kit.Text(ctx, label, t.Text.Body).FontWeight(500).SingleLine().Ellipsis("…")
			if desc != "" {
				kit.Text(ctx, desc, t.Text.Sm).TextColor(t.Muted).SingleLine().Ellipsis("…")
			}
		})
		control()
	})
}

func (s *settingsState) autoUpdateSwitch(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	label := "关闭"
	if s.autoUpdate {
		label = "开启"
	}
	track := ui.Row(ctx).Height(ctx.Theme().Space(5)).PaddingX(6).Radius(t.Radius.Sm).Gap(6).
		AlignItems(ui.Center).Focusable().Label("打开 扩展自动更新")
	if s.autoUpdate {
		track.Background(t.Primary)
	} else {
		track.Background(t.Hover)
	}
	track.OnClick(func() { go s.toggleAutoUpdate() })
	track.Children(func() {
		color := t.Foreground
		if s.autoUpdate {
			color = t.PrimaryText
		}
		kit.Text(ctx, label, t.Text.Xs).TextColor(color).SingleLine()
	})
}

func (s *settingsState) settingValue(ctx *ui.Context, value string) {
	kit.Text(ctx, value, gwtheme.Of(ctx).Text.Sm).TextColor(gwtheme.Of(ctx).Muted)
}
