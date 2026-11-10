package main

import (
	"encoding/json"
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

type resourceState struct {
	address string
	token   string
	status  string
	window  *mygo.Window
	rows    []resourceRow
	list    ui.ListState
}

func newResourceState(address, token string) *resourceState {
	return &resourceState{address: address, token: token, status: "正在读取能力库…"}
}

func (s *resourceState) load() {
	payload, err := daemonGet(s.address, s.token, "/api/capabilities/config")
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
		ui.Text(ctx, "资源").FontSize(18)
		if s.status != "" {
			ui.Text(ctx, s.status).FontSize(12).TextColor(t.TextMuted)
			return
		}
		ui.Text(ctx, "能力库 · "+resourceSummary(s.rows)).FontSize(12).TextColor(t.TextMuted)
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
