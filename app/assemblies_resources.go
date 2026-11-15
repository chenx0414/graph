package main

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type assemblyCapability struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Version string `json:"version"`
	Name    string `json:"name"`
	Role    string `json:"role"`
	Status  string `json:"status"`
}

func parseAssemblyCapabilities(payload []byte) []assemblyCapability {
	var body struct {
		Capabilities []assemblyCapability `json:"capabilities"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return nil
	}
	sort.SliceStable(body.Capabilities, func(a, b int) bool { return body.Capabilities[a].ID < body.Capabilities[b].ID })
	return body.Capabilities
}

func assemblyRoleForKind(capability assemblyCapability) string {
	switch capability.Kind {
	case "prompt":
		if capability.Role == "tool" {
			return "tool"
		}
		return "identity"
	case "skill", "mcp", "pi-extension", "extension":
		return capability.Kind
	}
	return "skill"
}

func (s *assemblyState) saveCombination(row assemblyRow, resources []assemblyResource) {
	combination := map[string]any{
		"id": row.id, "name": row.name, "description": row.description,
		"review": row.review, "tags": row.tags, "resources": resources,
	}
	if row.mode != "" {
		combination["mode"] = row.mode
	}
	if _, err := s.api.post("/api/catalog/combinations", map[string]any{"combination": combination}); err != nil {
		s.status = "保存资源失败：" + err.Error()
		s.frame()
		return
	}
	s.status = ""
	s.load()
	s.frame()
}

func (s *assemblyState) addResource(row assemblyRow, capability assemblyCapability) {
	for _, member := range row.resources {
		if member.ResourceID == capability.ID {
			return
		}
	}
	resources := append(append([]assemblyResource{}, row.resources...), assemblyResource{
		ResourceID: capability.ID, Version: capability.Version,
		Role: assemblyRoleForKind(capability), Required: true,
	})
	s.resourcePickerOpen = false
	s.resourceQuery = ""
	go s.saveCombination(row, resources)
}

func (s *assemblyState) removeResource(row assemblyRow, resourceID string) {
	resources := make([]assemblyResource, 0, len(row.resources))
	for _, member := range row.resources {
		if member.ResourceID != resourceID {
			resources = append(resources, member)
		}
	}
	go s.saveCombination(row, resources)
}

func (s *assemblyState) resourceCandidates(row assemblyRow) []assemblyCapability {
	query := strings.ToLower(strings.TrimSpace(s.resourceQuery))
	used := map[string]bool{}
	roles := map[string]bool{}
	for _, member := range row.resources {
		used[member.ResourceID] = true
		roles[member.Role] = true
	}
	matches := []assemblyCapability{}
	for _, capability := range s.capabilities {
		role := assemblyRoleForKind(capability)
		if used[capability.ID] || capability.Status != "available" {
			continue
		}
		if (role == "identity" || role == "tool") && roles[role] {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(capability.ID), query) && !strings.Contains(strings.ToLower(capability.Name), query) {
			continue
		}
		matches = append(matches, capability)
	}
	return matches
}

func (s *assemblyState) resourcePicker(ctx *ui.Context, t gwtheme.Tokens, row assemblyRow) {
	th := ctx.Theme()
	panel := ui.Column(ctx).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).Background(t.Card)
	panel.Children(func() {
		head := ui.Row(ctx).FillWidth().Padding(th.Space(2), th.Space(3)).Gap(th.Space(2)).AlignItems(ui.Center)
		head.Children(func() {
			field := kit.Input(ctx, &s.resourceQuery, kit.InputOpts{Placeholder: "查找资源库里的技能、指令、MCP…"})
			field.Grow(1)
			if kit.Button(ctx, "取消添加", kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeSm}).Clicked() {
				s.resourcePickerOpen = false
				s.resourceQuery = ""
				s.frame()
			}
		})
		ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border)
		candidates := s.resourceCandidates(row)
		if len(candidates) > 40 {
			candidates = candidates[:40]
		}
		for _, capability := range candidates {
			member := capability
			line := ui.Row(ctx).FillWidth().Padding(th.Space(2), th.Space(3)).Gap(th.Space(2)).AlignItems(ui.Center).
				Label("添加 " + member.ID)
			line.OnClick(func() { s.addResource(row, member) })
			line.Children(func() {
				ui.Icon(ctx, resourceKindIcon(member.Kind)).Size(13, 13).TextColor(t.Muted)
				ui.Column(ctx).Grow(1).Shrink(1).Gap(1).Children(func() {
					kit.Text(ctx, member.ID+"@"+member.Version, t.Text.Sm).Font(gwtheme.MonoFont).TextColor(t.Foreground).SingleLine().Ellipsis("…")
					kit.Text(ctx, resourceKindLabel(member.Kind)+" · "+member.Name, t.Text.Xs).TextColor(t.Muted).SingleLine()
				})
				kit.Text(ctx, "添加", t.Text.Xs).TextColor(t.Muted)
			})
			ui.Box(ctx).FillWidth().Height(gwtheme.Hairline).Background(t.Border).MarginX(th.Space(3))
		}
		if len(candidates) == 0 {
			ui.Box(ctx).FillWidth().Padding(th.Space(3)).Children(func() {
				kit.Text(ctx, "没有可添加的资源。", t.Text.Xs).TextColor(t.Muted)
			})
		}
	})
}
