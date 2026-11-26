package main

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/egoist/mygo"
)

type assemblyResource struct {
	ResourceID string `json:"resourceId"`
	Version    string `json:"version"`
	Role       string `json:"role"`
	Required   bool   `json:"required"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
}

type assemblyRow struct {
	id          string
	name        string
	description string
	mode        string
	review      bool
	tags        []string
	resources   []assemblyResource
	status      string
	issues      []string
	resolved    []assemblyResource
	definition  string
}

type assemblyCatalogPayload struct {
	Definitions []struct {
		ID      string `json:"id"`
		Version int64  `json:"version"`
	} `json:"definitions"`
	AgentCombinations []struct {
		ID          string             `json:"id"`
		Name        string             `json:"name"`
		Description string             `json:"description"`
		Mode        string             `json:"mode"`
		Review      bool               `json:"review"`
		Tags        []string           `json:"tags"`
		Resources   []assemblyResource `json:"resources"`
		Status      string             `json:"status"`
		Issues      []string           `json:"issues"`
		Resolved    []assemblyResource `json:"resolved"`
	} `json:"agentCombinations"`
	AgentCombinationFile  string `json:"agentCombinationFile"`
	AgentCombinationError string `json:"agentCombinationError"`
}

func parseAssemblies(payload []byte) ([]assemblyRow, string, string, error) {
	var body assemblyCatalogPayload
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil, "", "", err
	}
	versions := map[string]string{}
	for _, definition := range body.Definitions {
		versions[definition.ID] = definition.ID + "@" + strconv.FormatInt(definition.Version, 10)
	}
	rows := make([]assemblyRow, 0, len(body.AgentCombinations))
	for _, item := range body.AgentCombinations {
		rows = append(rows, assemblyRow{
			id: item.ID, name: item.Name, description: item.Description, mode: item.Mode,
			review: item.Review, tags: item.Tags, resources: item.Resources, status: item.Status,
			issues: item.Issues, resolved: item.Resolved, definition: versions[item.ID],
		})
	}
	return rows, body.AgentCombinationFile, body.AgentCombinationError, nil
}

type assemblyState struct {
	api                apiClient
	capabilities       []assemblyCapability
	resourcePickerOpen bool
	resourceQuery      string
	status             string
	file               string
	fileError          string
	rows               []assemblyRow
	selected           string
	compiledVersion    string
	draftDescription   string
	deleteArmed        string
	pendingSelect      string
	editingDescription bool
	editorOpen         bool
	editorID           string
	editorName         string
	editorDescription  string
	saveLabel          string
	openPath           func(string) error
	window             *mygo.Window
}

func newAssemblyState(address, token string) *assemblyState {
	claimShellOwner()
	return &assemblyState{api: newAPIClient(address, token), status: "正在读取能力装配…", openPath: mygo.Shell.OpenPath}
}

func (s *assemblyState) frame() {
	if s.window != nil {
		s.window.Update(func() {})
	}
}

func (s *assemblyState) assembly(id string) *assemblyRow {
	for index := range s.rows {
		if s.rows[index].id == id {
			return &s.rows[index]
		}
	}
	return nil
}

func (s *assemblyState) selectedRow() *assemblyRow {
	if s.selected == "" {
		return nil
	}
	return s.assembly(s.selected)
}

func (s *assemblyState) load() {
	// The request runs here; everything it produces is written where the renderer
	// owns it, so a background refresh cannot rewrite the rows a frame is reading.
	payload, err := s.api.get("/api/catalog")
	onUI(s.window, func() { s.applyCatalog(payload, err) })
}

func (s *assemblyState) applyCatalog(payload []byte, err error) {
	if err != nil {
		s.status = readFailureText(err, "能力装配")
		return
	}
	rows, file, fileError, err := parseAssemblies(payload)
	if err != nil {
		s.status = "能力装配不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = rows
	s.capabilities = parseAssemblyCapabilities(payload)
	s.file = file
	s.fileError = fileError
	s.status = ""
	s.refreshSelection()
	s.applyPendingSelect()
	s.frame()
}

func (s *assemblyState) refreshSelection() {
	if s.selectedRow() == nil {
		s.selected = ""
	}
	s.compiledVersion = ""
}

func (s *assemblyState) selectAssembly(id string) {
	s.selected = id
	s.status = ""
	s.editingDescription = false
	s.draftDescription = ""
	s.deleteArmed = ""
	s.editorOpen = false
	s.resourcePickerOpen = false
	s.resourceQuery = ""
	if row := s.assembly(id); row != nil {
		s.draftDescription = row.description
	}
	s.frame()
}

func (s *assemblyState) compile() {
	// This runs from a click handler on a bare goroutine, so the request stays
	// there and every field it settles is written where the page reads it.
	selected := readShell(s.window, func() string { return s.selected })
	if selected == "" {
		return
	}
	payload, err := s.api.post("/api/catalog/combinations/"+selected+"/compile", nil)
	var version string
	var body struct {
		DefinitionVersion string `json:"definitionVersion"`
	}
	if err == nil {
		err = json.Unmarshal(payload, &body)
		version = body.DefinitionVersion
	}
	onUI(s.window, func() {
		if err != nil {
			s.status = "编译失败：" + err.Error()
			s.frame()
			return
		}
		s.status = ""
		s.load()
		s.compiledVersion = version
		s.frame()
	})
}

func (s *assemblyState) saveDescription() {
	if s.selected == "" {
		return
	}
	description := strings.TrimSpace(s.draftDescription)
	if description == "" {
		s.status = "描述不能为空"
		s.frame()
		return
	}
	if _, err := s.api.post("/api/catalog/combinations/"+s.selected+"/description", map[string]any{"description": description}); err != nil {
		s.status = "保存失败：" + err.Error()
		s.frame()
		return
	}
	s.status = ""
	s.editingDescription = false
	s.load()
	s.frame()
}

func (s *assemblyState) deleteAssembly(id string) {
	row := s.assembly(id)
	if row == nil {
		return
	}
	if row.mode == "main" {
		s.status = "主 Agent 装配不能删除"
		s.frame()
		return
	}
	if s.deleteArmed != id {
		s.deleteArmed = id
		s.status = ""
		s.frame()
		return
	}
	if _, err := s.api.delete("/api/catalog/combinations/" + id); err != nil {
		s.status = "删除失败：" + err.Error()
		s.frame()
		return
	}
	s.deleteArmed = ""
	s.selected = ""
	s.status = ""
	s.load()
	s.frame()
}

func (s *assemblyState) duplicateAssembly(id string) {
	row := s.assembly(id)
	if row == nil {
		return
	}
	s.editorOpen = true
	s.editorID = id + "-copy"
	s.editorName = row.name + " 副本"
	s.editorDescription = row.description
	s.saveLabel = ""
	s.status = ""
	s.frame()
}

func (s *assemblyState) createAssembly() {
	id := strings.TrimSpace(s.editorID)
	name := strings.TrimSpace(s.editorName)
	description := strings.TrimSpace(s.editorDescription)
	if id == "" || name == "" || description == "" {
		s.status = "id、名称与描述都要填"
		s.frame()
		return
	}
	combination := map[string]any{
		"id": id, "name": name, "description": description, "review": false, "tags": []string{}, "resources": []assemblyResource{},
	}
	if source := s.editorSource(); source != nil {
		combination["resources"] = source.resources
		combination["tags"] = source.tags
		combination["review"] = source.review
	}
	payload, err := s.api.post("/api/catalog/combinations", map[string]any{"combination": combination})
	if err != nil {
		s.status = "新建失败：" + err.Error()
		s.frame()
		return
	}
	s.saveLabel = savedDefinitionVersion(payload)
	s.editorOpen = false
	s.status = ""
	s.load()
	s.frame()
}

func (s *assemblyState) editorSource() *assemblyRow {
	base := strings.TrimSuffix(s.editorID, "-copy")
	if base == s.editorID {
		return nil
	}
	return s.assembly(base)
}

func savedDefinitionVersion(payload []byte) string {
	var body struct {
		Definition struct {
			DefinitionVersion string `json:"definitionVersion"`
		} `json:"definition"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	return body.Definition.DefinitionVersion
}

func (s *assemblyState) openFile() {
	if s.file == "" {
		s.status = "还不知道装配文件在哪"
		s.frame()
		return
	}
	if s.openPath != nil {
		_ = s.openPath(s.file)
	}
	s.status = ""
	s.frame()
}
