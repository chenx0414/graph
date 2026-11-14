package main

import (
	"encoding/json"
	"strconv"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type projectRow struct {
	id       string
	state    string
	archived bool
}

type settingsSnapshot struct {
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
	api    apiClient
	status string
	window *mygo.Window
	rows   settingsSnapshot
	list   ui.ListState
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
	s.status = ""
	s.frame()
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
	t := ctx.Theme()
	ui.Column(ctx).Fill().Padding(16).Gap(10).Children(func() {
		if s.status != "" {
			ui.Text(ctx, s.status).FontSize(12).TextColor(t.TextMuted)
		}
		if s.rows.mode == "" && len(s.rows.projects) == 0 {
			return
		}
		ui.Text(ctx, "运行 · "+s.rows.mode+" · 配置版本 "+strconv.Itoa(s.rows.revision)).FontSize(12).TextColor(t.TextMuted)
		ui.Text(ctx, "源码 · "+s.rows.branch+"@"+shortCommit(s.rows.commit)+" · 模型 "+strconv.Itoa(s.rows.modelCount)+" 个可用").FontSize(12).TextColor(t.TextMuted)
		if s.rows.defaultModel != "" {
			ui.Text(ctx, "默认模型 · "+s.rows.defaultModel).FontSize(12).TextColor(t.TextMuted)
		}
		ui.Text(ctx, "凭据在「供应商」页管理 · 与 magpie 同一套").FontSize(12).TextColor(t.TextMuted)
		ui.Text(ctx, "项目").FontSize(13)
		ui.List(ctx, &s.list, len(s.rows.projects), func(index int) {
			row := s.rows.projects[index]
			ui.Row(ctx).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(ctx, projectLabel(row)).FontSize(12).Grow(1)
				action := "归档 " + row.id
				if row.archived {
					action = "恢复 " + row.id
				}
				if ui.Button(ctx, action).Clicked() {
					target := row
					go s.toggleProject(target)
				}
			})
		}).Grow(1)
	})
}
