package main

import (
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo"
)

type resourceRow struct {
	id          string
	kind        string
	name        string
	version     string
	origin      string
	status      string
	source      string
	description string
	repo        string
	fields      []resourceField
	configured  []string
	missing     []string
	err         string
	ready       bool
}

type resourceLibraryPayload struct {
	Capabilities []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Kind     string `json:"kind"`
		Version  string `json:"version"`
		Origin   string `json:"origin"`
		Status   string `json:"status"`
		Source   string `json:"source"`
		Error    string `json:"error"`
		Snapshot struct {
			Manifest struct {
				Description string `json:"description"`
				Source      string `json:"source"`
			} `json:"manifest"`
		} `json:"snapshot"`
	} `json:"capabilities"`
	AgentCombinations []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"agentCombinations"`
	AgentCombinationFile string `json:"agentCombinationFile"`
}

type resourceField struct {
	Env    string `json:"env"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
	Reason string `json:"reason"`
}

type resourceConfigPayload struct {
	Items []struct {
		ID         string          `json:"id"`
		Kind       string          `json:"kind"`
		Version    string          `json:"version"`
		Fields     []resourceField `json:"fields"`
		Configured []string        `json:"configured"`
		Missing    []string        `json:"missing"`
		Error      string          `json:"error"`
		Ready      bool            `json:"ready"`
	} `json:"items"`
}

func resourceConfigKey(id, version string) string {
	return id + "@" + version
}

func resourceRepo(sourceURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(sourceURL))
	if err != nil || parsed.Host == "" {
		return ""
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[0] + "/" + parts[1]
}

func parseResourceLibrary(catalog, config []byte) ([]resourceRow, error) {
	var listed resourceLibraryPayload
	if err := json.Unmarshal(catalog, &listed); err != nil {
		return nil, err
	}
	var wired resourceConfigPayload
	if len(config) > 0 {
		if err := json.Unmarshal(config, &wired); err != nil {
			return nil, err
		}
	}
	missingByID := map[string][]string{}
	fieldsByID := map[string][]resourceField{}
	configuredByID := map[string][]string{}
	for _, item := range wired.Items {
		missingByID[resourceConfigKey(item.ID, item.Version)] = item.Missing
		fieldsByID[resourceConfigKey(item.ID, item.Version)] = item.Fields
		configuredByID[resourceConfigKey(item.ID, item.Version)] = item.Configured
		if _, ok := missingByID[item.ID]; !ok {
			missingByID[item.ID] = item.Missing
			fieldsByID[item.ID] = item.Fields
			configuredByID[item.ID] = item.Configured
		}
	}
	rows := make([]resourceRow, 0, len(listed.Capabilities))
	for _, item := range listed.Capabilities {
		if item.ID == "" {
			continue
		}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = item.ID
		}
		missing := missingByID[resourceConfigKey(item.ID, item.Version)]
		fields := fieldsByID[resourceConfigKey(item.ID, item.Version)]
		if missing == nil {
			missing = missingByID[item.ID]
		}
		if fields == nil {
			fields = fieldsByID[item.ID]
		}
		configured := configuredByID[resourceConfigKey(item.ID, item.Version)]
		if configured == nil {
			configured = configuredByID[item.ID]
		}
		errText := strings.TrimSpace(item.Error)
		status := item.Status
		if status == "" {
			status = "available"
		}
		ready := status == "available" && len(missing) == 0 && errText == ""
		rows = append(rows, resourceRow{
			id: item.ID, kind: item.Kind, name: name, version: item.Version, origin: item.Origin,
			status: status, source: item.Source, description: item.Snapshot.Manifest.Description,
			repo: resourceRepo(item.Snapshot.Manifest.Source), fields: fields, configured: configured,
			missing: missing, err: errText, ready: ready,
		})
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
	switch {
	case len(row.missing) > 0:
		label += " · 缺 " + strings.Join(row.missing, "、")
	case row.err != "":
		label += " · 加载失败：" + row.err
	case !row.ready:
		label += " · 不可用（" + row.status + "）"
	}
	return label
}

type resourceLine struct {
	row    resourceRow
	kind   string
	header bool
}

func resourceRows(rows []resourceRow) []resourceLine {
	counts := map[string]int{}
	for _, row := range rows {
		counts[row.kind]++
	}
	lines := make([]resourceLine, 0, len(rows)+len(counts))
	kind := ""
	for _, row := range rows {
		if row.kind != kind {
			kind = row.kind
			lines = append(lines, resourceLine{kind: kind + " · " + strconv.Itoa(counts[kind]), header: true})
		}
		lines = append(lines, resourceLine{row: row})
	}
	return lines
}

func resourceSummary(rows []resourceRow) string {
	ready, pending := 0, 0
	for _, row := range rows {
		if row.ready {
			ready++
		}
		if len(row.missing) > 0 {
			pending++
		}
	}
	return strconv.Itoa(ready) + " / " + strconv.Itoa(len(rows)) + " 可用 · " + strconv.Itoa(pending) + " 个待配置"
}

type catalogRoot struct {
	CapabilityRoot string `json:"capabilityRoot"`
}

type resourceState struct {
	api          apiClient
	appToken     string
	secretsPath  string
	status       string
	root         string
	search       string
	kind         string
	showAllFound bool
	selected     string
	draftEnv     string
	draftValue   string
	saved        map[string]string
	openPath     func(string) error
	window       *mygo.Window
	rows         []resourceRow
}

func (s *resourceState) resource(id string) *resourceRow {
	for index := range s.rows {
		if s.rows[index].id == id {
			return &s.rows[index]
		}
	}
	return nil
}

func (s *resourceState) selectedRow() *resourceRow {
	if s.selected == "" {
		return nil
	}
	return s.resource(s.selected)
}

func (s *resourceState) selectResource(id string) {
	s.selected = id
	s.draftEnv = ""
	s.draftValue = ""
	s.frame()
}

func (s *resourceState) saveEnv() {
	// Called from a click on a bare goroutine: the fields it reads and settles
	// belong to the shell's writer, and only the request leaves it.
	ref := readShell(s.window, func() string { return strings.TrimSpace(s.draftEnv) })
	value := readShell(s.window, func() string { return strings.TrimSpace(s.draftValue) })
	secretsPath := readShell(s.window, func() string { return s.secretsPath })
	if ref == "" || value == "" {
		onUI(s.window, func() {
			if ref == "" {
				s.status = "先选一个字段再保存"
			} else {
				s.status = "这个字段的值不能为空"
			}
			s.frame()
		})
		return
	}
	body := map[string]any{"ref": ref, "value": value, "persisted": true}
	var saveErr error
	if _, err := s.api.postApp("/api/app/secret", s.appToken, body); err != nil {
		saveErr = err
	} else if secretsPath != "" {
		saveErr = saveSecret(secretsPath, ref, &value)
	}
	onUI(s.window, func() {
		if saveErr != nil {
			s.status = "保存失败：" + saveErr.Error()
			s.frame()
			return
		}
		if s.saved == nil {
			s.saved = map[string]string{}
		}
		s.saved[ref] = value
		s.draftValue = ""
		s.status = ""
		s.load()
		s.frame()
	})
}

func newResourceState(address, token string) *resourceState {
	claimShellOwner()
	return &resourceState{api: newAPIClient(address, token), status: "正在读取资源库…", openPath: mygo.Shell.OpenPath}
}

func (s *resourceState) revokeEnv(ref string) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		s.status = "先选一个字段"
		s.frame()
		return
	}
	if _, err := s.api.postApp("/api/app/secret", s.appToken, map[string]any{"ref": ref, "value": nil}); err != nil {
		s.status = "撤销失败：" + err.Error()
		s.frame()
		return
	}
	if s.secretsPath != "" {
		if err := saveSecret(s.secretsPath, ref, nil); err != nil {
			s.status = "撤销被 daemon 接受，但本机没能清理（" + err.Error() + "）"
			s.frame()
			return
		}
	}
	delete(s.saved, ref)
	s.draftEnv = ""
	s.draftValue = ""
	s.status = ""
	s.load()
	s.frame()
}

func (s *resourceState) load() {
	catalog, err := s.api.get("/api/catalog")
	if err != nil {
		s.status = readFailureText(err, "资源库")
		return
	}
	config, configErr := s.api.get("/api/capabilities/config")
	if configErr != nil {
		config = nil
	}
	rows, err := parseResourceLibrary(catalog, config)
	if err != nil {
		s.status = "资源库不是预期的 JSON：" + err.Error()
		return
	}
	s.rows = rows
	s.reloadRoot()
	s.status = ""
	s.frame()
}

func (s *resourceState) refresh() {
	_, err := s.api.post("/api/catalog/refresh", nil)
	onUI(s.window, func() {
		if err != nil {
			s.status = "刷新失败：" + err.Error()
			s.frame()
			return
		}
		s.load()
	})
}

func (s *resourceState) reloadRoot() {
	payload, err := s.api.get("/api/settings")
	if err != nil {
		return
	}
	var named catalogRoot
	if json.Unmarshal(payload, &named) == nil {
		s.root = strings.TrimSpace(named.CapabilityRoot)
	}
}

func (s *resourceState) openDirectory() {
	root := readShell(s.window, func() string { return s.root })
	openPath := readShell(s.window, func() func(string) error { return s.openPath })
	if root == "" || openPath == nil {
		onUI(s.window, func() {
			s.status = "还不知道能力目录在哪"
			s.frame()
		})
		return
	}
	if err := openPath(root); err != nil {
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
