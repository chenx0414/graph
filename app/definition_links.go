package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func definitionAssemblyID(definition string) string {
	value := strings.TrimSpace(definition)
	if value == "" {
		return ""
	}
	id, _, _ := strings.Cut(value, "@")
	return strings.TrimSpace(id)
}

func (s *shellState) openAssemblyDefinition(definition string) {
	id := definitionAssemblyID(definition)
	s.openModule("assemblies")
	s.ensureAssemblies()
	if s.assemblies == nil {
		return
	}
	if id == "" {
		return
	}
	s.assemblies.focusDefinition(definition)
}

func (s *assemblyState) focusDefinition(definition string) {
	id := definitionAssemblyID(definition)
	if id == "" {
		return
	}
	if row := s.assembly(id); row != nil {
		s.selectAssembly(id)
		s.pendingSelect = ""
		return
	}
	if len(s.rows) > 0 {
		s.status = "definition " + definition + " 没有对应的装配（可能来自内置定义）"
		s.pendingSelect = ""
		s.frame()
		return
	}
	s.pendingSelect = definition
}

func (s *assemblyState) applyPendingSelect() {
	if s.pendingSelect == "" {
		return
	}
	definition := s.pendingSelect
	s.pendingSelect = ""
	id := definitionAssemblyID(definition)
	if row := s.assembly(id); row != nil {
		s.selectAssembly(id)
		return
	}
	s.status = "definition " + definition + " 没有对应的装配（可能来自内置定义）"
}

func (s *shellState) definitionLink(ctx *ui.Context, t gwtheme.Tokens, definition string) {
	if strings.TrimSpace(definition) == "" {
		return
	}
	label := "装配 " + definitionAssemblyID(definition)
	button := kit.Button(ctx, label, kit.ButtonOpts{Variant: kit.Ghost, Size: kit.SizeXs})
	if button.Clicked() {
		s.openAssemblyDefinition(definition)
	}
}
