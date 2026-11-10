package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type credentialRow struct {
	id         string
	name       string
	configured bool
}

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
	credentials  []credentialRow
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

type configPayload struct {
	Revision int `json:"revision"`
	Config   struct {
		Credentials map[string]struct {
			DisplayName string `json:"displayName"`
			Configured  bool   `json:"configured"`
		} `json:"credentials"`
	} `json:"config"`
}

func parseSettings(startup, settings, config []byte) (settingsSnapshot, error) {
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
	var wired configPayload
	if err := json.Unmarshal(config, &wired); err != nil {
		return snapshot, err
	}
	if wired.Revision > 0 {
		snapshot.revision = wired.Revision
	}
	for id, credential := range wired.Config.Credentials {
		name := strings.TrimSpace(credential.DisplayName)
		if name == "" {
			name = id
		}
		snapshot.credentials = append(snapshot.credentials, credentialRow{id: id, name: name, configured: credential.Configured})
	}
	sort.Slice(snapshot.credentials, func(a, b int) bool { return snapshot.credentials[a].name < snapshot.credentials[b].name })
	return snapshot, nil
}

func shortCommit(commit string) string {
	if len(commit) > 8 {
		return commit[:8]
	}
	return commit
}

func credentialLabel(row credentialRow) string {
	mark := "○"
	if row.configured {
		mark = "●"
	}
	return mark + " " + row.name
}

func projectLabel(row projectRow) string {
	label := row.id + " · " + row.state
	if row.archived {
		label += " · 已归档"
	}
	return label
}

type settingsState struct {
	address string
	token   string
	status  string
	window  *mygo.Window
	rows    settingsSnapshot
	list    ui.ListState
}

func newSettingsState(address, token string) *settingsState {
	return &settingsState{address: address, token: token, status: "正在读取设置…"}
}

func (s *settingsState) load() {
	startup, err := daemonGet(s.address, s.token, "/api/startup")
	if err != nil {
		s.status = "读不到运行信息：" + err.Error()
		return
	}
	settings, err := daemonGet(s.address, s.token, "/api/settings")
	if err != nil {
		s.status = "读不到设置：" + err.Error()
		return
	}
	config, err := daemonGet(s.address, s.token, "/api/config")
	if err != nil {
		s.status = "读不到配置：" + err.Error()
		return
	}
	snapshot, err := parseSettings(startup, settings, config)
	if err != nil {
		s.status = "设置不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = snapshot
	s.status = ""
	s.frame()
}

func (s *settingsState) post(path string) {
	request, err := http.NewRequest("POST", strings.TrimSuffix(s.address, "/")+path, bytes.NewReader([]byte("{}")))
	if err != nil {
		s.status = "操作失败：" + err.Error()
		return
	}
	if token := strings.TrimSpace(s.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		s.status = "操作失败：" + err.Error()
		return
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		s.status = "操作被拒绝：" + response.Status
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
		ui.Text(ctx, "设置").FontSize(18)
		if s.status != "" {
			ui.Text(ctx, s.status).FontSize(12).TextColor(t.TextMuted)
			return
		}
		ui.Text(ctx, "运行 · "+s.rows.mode+" · 配置版本 "+strconv.Itoa(s.rows.revision)).FontSize(12).TextColor(t.TextMuted)
		ui.Text(ctx, "源码 · "+s.rows.branch+"@"+shortCommit(s.rows.commit)+" · 模型 "+strconv.Itoa(s.rows.modelCount)+" 个可用").FontSize(12).TextColor(t.TextMuted)
		if s.rows.defaultModel != "" {
			ui.Text(ctx, "默认模型 · "+s.rows.defaultModel).FontSize(12).TextColor(t.TextMuted)
		}
		ui.Text(ctx, "订阅凭据").FontSize(13)
		for _, credential := range s.rows.credentials {
			ui.Text(ctx, credentialLabel(credential)).FontSize(12)
		}
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
