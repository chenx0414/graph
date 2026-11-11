package main

import (
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type resourceRow struct {
	kind    string
	name    string
	version string
	missing []string
	ready   bool
}

type resourceCatalogPayload struct {
	Items []struct {
		ID      string   `json:"id"`
		Name    string   `json:"name"`
		Kind    string   `json:"kind"`
		Version string   `json:"version"`
		Missing []string `json:"missing"`
		Ready   bool     `json:"ready"`
	} `json:"items"`
}

func parseResources(payload []byte) ([]resourceRow, error) {
	var catalog resourceCatalogPayload
	if err := json.Unmarshal(payload, &catalog); err != nil {
		return nil, err
	}
	rows := make([]resourceRow, 0, len(catalog.Items))
	for _, item := range catalog.Items {
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = item.ID
		}
		rows = append(rows, resourceRow{kind: item.Kind, name: name, version: item.Version, missing: item.Missing, ready: item.Ready})
	}
	sort.SliceStable(rows, func(a, b int) bool {
		if rows[a].kind != rows[b].kind {
			return rows[a].kind < rows[b].kind
		}
		return rows[a].name < rows[b].name
	})
	return rows, nil
}

func resourceLabel(row resourceRow) string {
	label := row.name
	if row.version != "" {
		label += " · v" + row.version
	}
	if row.ready {
		return label + " · 就绪"
	}
	if len(row.missing) > 0 {
		return label + " · 缺 " + strings.Join(row.missing, "、")
	}
	return label + " · 未就绪"
}

type resourceLine struct {
	row    resourceRow
	kind   string
	header bool
}

func resourceRows(rows []resourceRow) []resourceLine {
	lines := make([]resourceLine, 0, len(rows))
	kind := ""
	for _, row := range rows {
		if row.kind != kind {
			kind = row.kind
			lines = append(lines, resourceLine{kind: kind, header: true})
		}
		lines = append(lines, resourceLine{row: row})
	}
	return lines
}

func resourceSummary(rows []resourceRow) string {
	ready := 0
	for _, row := range rows {
		if row.ready {
			ready++
		}
	}
	return strconv.Itoa(ready) + " / " + strconv.Itoa(len(rows)) + " 就绪"
}

type configDocument struct {
	Revision int             `json:"revision"`
	Config   json.RawMessage `json:"config"`
}

type catalogRoot struct {
	CapabilityRoot string `json:"capabilityRoot"`
}

type resourceState struct {
	api        apiClient
	status     string
	root       string
	document   json.RawMessage
	revision   int
	autoUpdate bool
	openPath   func(string) error
	window     *mygo.Window
	rows       []resourceRow
	list       ui.ListState
}

func newResourceState(address, token string) *resourceState {
	return &resourceState{api: newAPIClient(address, token), status: "正在读取能力库…", openPath: mygo.Shell.OpenPath}
}

func (s *resourceState) load() {
	payload, err := s.api.get("/api/capabilities/config")
	if err != nil {
		s.status = "读不到能力库：" + err.Error()
		return
	}
	rows, err := parseResources(payload)
	if err != nil {
		s.status = "能力库不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = rows
	s.reloadConfig()
	s.status = ""
	s.frame()
}

func (s *resourceState) reloadConfig() {
	if payload, err := s.api.get("/api/settings"); err == nil {
		var named catalogRoot
		if json.Unmarshal(payload, &named) == nil {
			s.root = strings.TrimSpace(named.CapabilityRoot)
		}
	}
	payload, err := s.api.get("/api/config")
	if err != nil {
		return
	}
	var document configDocument
	if json.Unmarshal(payload, &document) != nil || len(document.Config) == 0 {
		return
	}
	var shaped map[string]any
	if json.Unmarshal(document.Config, &shaped) != nil {
		return
	}
	s.document = document.Config
	s.revision = document.Revision
	s.autoUpdate, _ = shaped["piExtensionAutoUpdate"].(bool)
}

func (s *resourceState) toggleAutoUpdate() {
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
		var rejected errStatus
		if errors.As(err, &rejected) {
			s.status = "写入被拒绝：" + err.Error() + "（配置可能已被别处改过，重进资源页会重读）"
		} else {
			s.status = "写入失败：" + err.Error()
		}
		s.frame()
		return
	}
	s.status = ""
	s.load()
}

func (s *resourceState) openDirectory() {
	if s.root == "" || s.openPath == nil {
		s.status = "还不知道能力目录在哪"
		s.frame()
		return
	}
	if err := s.openPath(s.root); err != nil {
		s.status = "打不开能力目录：" + err.Error()
		s.frame()
		return
	}
	s.status = ""
	s.frame()
}

func (s *resourceState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}

func (s *resourceState) view(ctx *ui.Context) {
	t := ctx.Theme()
	ui.Column(ctx).Fill().Padding(16).Gap(10).Children(func() {
		if s.status != "" {
			ui.Text(ctx, s.status).FontSize(12).TextColor(t.TextMuted)
			return
		}
		ui.Text(ctx, "能力库 · "+resourceSummary(s.rows)).FontSize(12).TextColor(t.TextMuted)
		ui.Row(ctx).Gap(8).AlignItems(ui.Center).Children(func() {
			if ui.Button(ctx, "打开能力目录").Clicked() {
				go s.openDirectory()
			}
			label := "扩展自动更新：关"
			if s.autoUpdate {
				label = "扩展自动更新：开"
			}
			if ui.Button(ctx, label).Clicked() {
				go s.toggleAutoUpdate()
			}
			if s.root != "" {
				ui.Text(ctx, s.root).FontSize(11).TextColor(t.TextMuted).Grow(1)
			}
		})
		lines := resourceRows(s.rows)
		ui.List(ctx, &s.list, len(lines), func(index int) {
			line := lines[index]
			if line.header {
				ui.Text(ctx, line.kind).FontSize(12).TextColor(t.TextMuted)
				return
			}
			ui.Text(ctx, resourceLabel(line.row)).FontSize(12)
		}).Grow(1)
	})
}
