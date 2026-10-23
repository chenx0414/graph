package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// CapabilityKind is the kind of a capability entry: skill, mcp, extension,
// pi-extension or prompt. It stays an alias of string because the manifest
// parser hands plain strings around.
type CapabilityKind = string

const (
	CapabilityKindSkill       CapabilityKind = "skill"
	CapabilityKindMCP         CapabilityKind = "mcp"
	CapabilityKindExtension   CapabilityKind = "extension"
	CapabilityKindPiExtension CapabilityKind = "pi-extension"
	CapabilityKindPrompt      CapabilityKind = "prompt"
)

// CapabilityOrigin is where a skill entry came from. The order matters: it decides
// which of several entries that share a name the library shows.
//
// A library entry comes first because it is the only one that can be bound, and binding
// mirrors it into the Agent's own folder, which is where the native loader looks first - so
// the bound copy is the one that actually reaches the model. A hand-placed entry in the
// Agent's folder comes next (it wins while nothing is bound), then the global folders and
// finally the project's own folders.
type CapabilityOrigin string

const (
	CapabilityOriginLibrary CapabilityOrigin = "library"
	CapabilityOriginAgent   CapabilityOrigin = "agent"
	CapabilityOriginGlobal  CapabilityOrigin = "global"
	CapabilityOriginProject CapabilityOrigin = "project"
)

// capabilityOriginOrder ranks the origins. The library entry wins, then a hand-placed
// Agent entry, then the global folders, then the project's own folders.
var capabilityOriginOrder = map[CapabilityOrigin]int{
	CapabilityOriginLibrary: 0,
	CapabilityOriginAgent:   1,
	CapabilityOriginGlobal:  2,
	CapabilityOriginProject: 3,
}

// CapabilityDuplicate is a same-name entry the library folded into another one.
type CapabilityDuplicate struct {
	Id      string `json:"id"`
	Version string `json:"version"`
	Source  string `json:"source"`
}

// CapabilityRecord is one entry of the capability library.
type CapabilityRecord struct {
	Id            string                `json:"id"`
	Kind          CapabilityKind        `json:"kind"`
	Source        string                `json:"source"`
	Version       string                `json:"version"`
	Snapshot      Json                  `json:"snapshot"`
	Status        string                `json:"status"`
	Name          string                `json:"name,omitempty"`
	Description   string                `json:"description,omitempty"`
	Role          string                `json:"role,omitempty"`
	Error         string                `json:"error,omitempty"`
	Owner         string                `json:"owner,omitempty"`
	Note          string                `json:"note,omitempty"`
	Origin        CapabilityOrigin      `json:"origin,omitempty"`
	PackageSource *string               `json:"packageSource,omitempty"`
	Base          bool                  `json:"base,omitempty"`
	Duplicates    []CapabilityDuplicate `json:"duplicates,omitempty"`
}

// CapabilitySearchInput filters the capability list.
type CapabilitySearchInput struct {
	Query  string         `json:"query,omitempty"`
	Kind   CapabilityKind `json:"kind,omitempty"`
	Role   string         `json:"role,omitempty"`
	Limit  int            `json:"limit,omitempty"`
	Offset int            `json:"offset,omitempty"`
}

// CapabilitySearchResult is one page of the capability list.
type CapabilitySearchResult struct {
	Total   int                `json:"total"`
	Offset  int                `json:"offset"`
	Limit   int                `json:"limit"`
	HasMore bool               `json:"hasMore"`
	Items   []CapabilityRecord `json:"items"`
}

// CapabilityBundleInput is one capability bundle to install into the capability root.
type CapabilityBundleInput struct {
	Manifest  Json              `json:"manifest"`
	Files     map[string]string `json:"files,omitempty"`
	Overwrite bool              `json:"overwrite,omitempty"`
}

// AgentCombinationSearchInput filters the recipe list.
type AgentCombinationSearchInput struct {
	Query string     `json:"query,omitempty"`
	Grade ModelGrade `json:"grade,omitempty"`
	Limit int        `json:"limit,omitempty"`
}

// AgentCombinationSearchResult is one page of the recipe list.
type AgentCombinationSearchResult struct {
	Total int                    `json:"total"`
	Items []AgentCombinationView `json:"items"`
}

// CapabilityLibraryOptions are the filesystem locations the library reads.
type CapabilityLibraryOptions struct {
	CapabilityRoot string
	RecipesPath    string
	// Projects are the configured projects, read at refresh time, so their own skill
	// folders are listed.
	Projects func() []ProjectConfig
}

// CapabilityLibrarySnapshot is the library view after a refresh.
type CapabilityLibrarySnapshot struct {
	Capabilities      []CapabilityRecord     `json:"capabilities"`
	AgentCombinations []AgentCombinationView `json:"agentCombinations"`
}

// CapabilityBundleResult is an installed capability bundle.
type CapabilityBundleResult struct {
	Capability CapabilityRecord `json:"capability"`
	Directory  string           `json:"directory"`
}

// DeletedAgentCombination reports a removed recipe.
type DeletedAgentCombination struct {
	Id      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// capabilityBundleDirectories is where each kind of bundle is installed.
var capabilityBundleDirectories = map[CapabilityKind]string{
	CapabilityKindSkill:       "skills",
	CapabilityKindMCP:         "mcp",
	CapabilityKindExtension:   "graph-extensions",
	CapabilityKindPiExtension: "pi-extensions",
	CapabilityKindPrompt:      "agent-md",
}

var (
	capabilityBundlePrefix    = regexp.MustCompile(`^\./+`)
	capabilityBundleHeaderRef = regexp.MustCompile(`^\$\{[A-Za-z_][A-Za-z0-9_]*\}$`)
)

// CapabilitySourceLabel is what the library view calls one entry's source.
func CapabilitySourceLabel(record CapabilityRecord) string {
	if record.Owner != "" {
		return record.Owner
	}
	if record.Origin == "" || record.Origin == CapabilityOriginLibrary {
		return "能力库"
	}
	return string(record.Origin)
}

func capabilityOriginRank(record CapabilityRecord) int {
	if record.Origin == "" {
		return capabilityOriginOrder[CapabilityOriginLibrary]
	}
	return capabilityOriginOrder[record.Origin]
}

// GroupCapabilitiesByName folds same-name skill entries into one row.
//
// One row per skill name: several entries that share a name resolve to a single skill for
// the native loader, so the library shows the one that decides the outcome and lists the
// rest. The origin order picks the entry; within one origin the shortest id wins, then the
// alphabet, so the result never depends on scan order.
func GroupCapabilitiesByName(records []CapabilityRecord) []CapabilityRecord {
	groups := map[string][]CapabilityRecord{}
	order := []string{}
	grouped := []CapabilityRecord{}
	for _, record := range records {
		if record.Kind != CapabilityKindSkill {
			grouped = append(grouped, record)
			continue
		}
		key := record.Name
		if key == "" {
			key = record.Id
		}
		if _, seen := groups[key]; !seen {
			order = append(order, key)
		}
		groups[key] = append(groups[key], record)
	}
	for _, key := range order {
		bucket := groups[key]
		sort.SliceStable(bucket, func(i, j int) bool {
			left, right := bucket[i], bucket[j]
			leftRank, rightRank := capabilityOriginRank(left), capabilityOriginRank(right)
			if leftRank != rightRank {
				return leftRank < rightRank
			}
			if len(left.Id) != len(right.Id) {
				return len(left.Id) < len(right.Id)
			}
			return lessByByteOrder(left.Id, right.Id)
		})
		winner := bucket[0]
		if len(bucket) == 1 {
			grouped = append(grouped, winner)
			continue
		}
		duplicates := make([]CapabilityDuplicate, 0, len(bucket)-1)
		for _, record := range bucket[1:] {
			duplicates = append(duplicates, CapabilityDuplicate{
				Id: record.Id, Version: record.Version, Source: CapabilitySourceLabel(record),
			})
		}
		winner.Duplicates = duplicates
		grouped = append(grouped, winner)
	}
	return grouped
}

// CapabilityLibrary is the filesystem-backed capability library and its Agent recipes.
type CapabilityLibrary struct {
	capabilityRoot    string
	recipesPath       string
	projects          func() []ProjectConfig
	capabilitiesCache []CapabilityRecord
	recipes           []AgentCombination
	recipesError      *string
}

// NewCapabilityLibrary opens the library over the given locations.
func NewCapabilityLibrary(options CapabilityLibraryOptions) *CapabilityLibrary {
	return &CapabilityLibrary{
		capabilityRoot: options.CapabilityRoot,
		recipesPath:    options.RecipesPath,
		projects:       options.Projects,
	}
}

func capabilityLibraryHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// RefreshCapabilities rescans the capability root and the native skill folders.
func (library *CapabilityLibrary) RefreshCapabilities() []CapabilityRecord {
	if library.capabilityRoot == "" {
		library.capabilitiesCache = []CapabilityRecord{}
		return library.Capabilities()
	}
	// Skills the user placed belong to the same library view: an Agent's own folder, the
	// global folders - the Pi agent directory and `.agents` - which every Agent loads, and
	// each configured project's own `.pi`/`.agents` folders, which reach the Agents that
	// work in it.
	placed := ScanAgentSkills(filepath.Join(filepath.Dir(library.capabilityRoot), "agents"))
	global := ScanNativeSkills(filepath.Join(defaultPiAgentDir(), "skills"), "全局（Pi agent 目录）", CapabilityOriginGlobal)
	agents := ScanNativeSkills(filepath.Join(capabilityLibraryHome(), ".agents", "skills"), "全局（~/.agents）", CapabilityOriginGlobal)
	projects := []CapabilityRecord{}
	if library.projects != nil {
		for _, project := range library.projects() {
			projects = append(projects, ScanNativeSkills(filepath.Join(project.Root, piConfigDirName, "skills"), "项目 "+project.Id+"（.pi）", CapabilityOriginProject)...)
			projects = append(projects, ScanNativeSkills(filepath.Join(project.Root, ".agents", "skills"), "项目 "+project.Id+"（.agents）", CapabilityOriginProject)...)
		}
	}
	records := []CapabilityRecord{}
	records = append(records, ScanCapabilities(library.capabilityRoot)...)
	records = append(records, placed...)
	records = append(records, global...)
	records = append(records, agents...)
	records = append(records, projects...)
	library.capabilitiesCache = records
	return library.Capabilities()
}

// Refresh rescans the capabilities and reloads the Agent recipes.
func (library *CapabilityLibrary) Refresh() CapabilityLibrarySnapshot {
	library.RefreshCapabilities()
	if library.recipesPath != "" {
		library.readRecipes()
	}
	return CapabilityLibrarySnapshot{
		Capabilities:      library.Capabilities(),
		AgentCombinations: library.AgentCombinations(),
	}
}

// readRecipes loads the recipe document. A broken document empties the recipes and keeps
// the error message, the way the TypeScript library did.
func (library *CapabilityLibrary) readRecipes() {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		library.recipes = []AgentCombination{}
		message := panicMessage(recovered)
		library.recipesError = &message
	}()
	document := ReadAgentCombinations(library.recipesPath)
	library.recipes = document.Combinations
	library.recipesError = nil
}

// CapabilityRootPath is the writable capability directory, empty when there is none.
func (library *CapabilityLibrary) CapabilityRootPath() string {
	return library.capabilityRoot
}

// AgentCombinationFilePath is the recipe document path, empty when there is none.
func (library *CapabilityLibrary) AgentCombinationFilePath() string {
	return library.recipesPath
}

// AgentCombinationError is the recipe load error, nil when the document loaded.
func (library *CapabilityLibrary) AgentCombinationError() *string {
	return library.recipesError
}

// Capabilities is the scanned capability list.
func (library *CapabilityLibrary) Capabilities() []CapabilityRecord {
	out := make([]CapabilityRecord, len(library.capabilitiesCache))
	copy(out, library.capabilitiesCache)
	return out
}

// CapabilitiesView is the list the resource library renders: one row per skill name,
// duplicates folded.
func (library *CapabilityLibrary) CapabilitiesView() []CapabilityRecord {
	return GroupCapabilitiesByName(library.capabilitiesCache)
}

// Capability resolves one capability id, optionally pinned to a version.
func (library *CapabilityLibrary) Capability(id string, version string) *CapabilityRecord {
	return SelectCapabilityRecord(library.capabilitiesCache, id, version)
}

// Search filters the capability list.
func (library *CapabilityLibrary) Search(input CapabilitySearchInput) CapabilitySearchResult {
	query := strings.ToLower(strings.TrimSpace(input.Query))
	terms := []string{}
	for _, term := range strings.Fields(query) {
		if term != "" {
			terms = append(terms, term)
		}
	}
	limit := 20
	if input.Limit > 0 {
		limit = min(input.Limit, 50)
	}
	offset := 0
	if input.Offset > 0 {
		offset = input.Offset
	}
	matches := []CapabilityRecord{}
	for _, record := range library.capabilitiesCache {
		if input.Kind != "" && record.Kind != input.Kind {
			continue
		}
		if input.Role != "" && record.Role != input.Role {
			continue
		}
		if len(terms) > 0 {
			parts := []string{}
			for _, part := range []string{record.Id, record.Kind, record.Version, record.Name, record.Description, record.Source, record.Role} {
				if part != "" {
					parts = append(parts, part)
				}
			}
			haystack := strings.ToLower(strings.Join(parts, "\n"))
			matched := true
			for _, term := range terms {
				if !strings.Contains(haystack, term) {
					matched = false
					break
				}
			}
			if !matched {
				continue
			}
		}
		matches = append(matches, record)
	}
	items := []CapabilityRecord{}
	if offset < len(matches) {
		end := offset + limit
		if end > len(matches) {
			end = len(matches)
		}
		items = matches[offset:end]
	}
	return CapabilitySearchResult{
		Total:   len(matches),
		Offset:  offset,
		Limit:   limit,
		HasMore: offset+limit < len(matches),
		Items:   items,
	}
}

// AgentCombinations validates every recipe against the current capability projection.
func (library *CapabilityLibrary) AgentCombinations() []AgentCombinationView {
	views := make([]AgentCombinationView, 0, len(library.recipes))
	for _, recipe := range library.recipes {
		views = append(views, ValidateAgentCombination(recipe, library.capabilitiesCache))
	}
	return views
}

// AgentCombination resolves one recipe by id.
func (library *CapabilityLibrary) AgentCombination(id string) *AgentCombinationView {
	views := library.AgentCombinations()
	for i := range views {
		if views[i].Id == id {
			return &views[i]
		}
	}
	return nil
}

// SearchAgentCombinations filters the recipe list.
func (library *CapabilityLibrary) SearchAgentCombinations(input AgentCombinationSearchInput) AgentCombinationSearchResult {
	query := strings.ToLower(strings.TrimSpace(input.Query))
	if len(query) > 200 {
		Raise("invalid_input", "Agent combination query must be at most 200 characters")
	}
	limit := 30
	if input.Limit > 0 {
		limit = min(input.Limit, 50)
	}
	matches := []AgentCombinationView{}
	for _, item := range library.AgentCombinations() {
		if input.Grade != "" && !ModelGradeMatches(input.Grade, item.RecommendedGrade) {
			continue
		}
		if query == "" {
			matches = append(matches, item)
			continue
		}
		parts := []string{item.Id, item.Name, item.Description, string(item.RecommendedGrade)}
		parts = append(parts, item.Tags...)
		for _, resource := range item.Resources {
			parts = append(parts, resource.ResourceId)
		}
		if strings.Contains(strings.ToLower(strings.Join(parts, "\n")), query) {
			matches = append(matches, item)
		}
	}
	items := matches
	if len(items) > limit {
		items = items[:limit]
	}
	return AgentCombinationSearchResult{Total: len(matches), Items: items}
}

// SaveAgentCombination persists one recipe and returns its validated view.
func (library *CapabilityLibrary) SaveAgentCombination(combination AgentCombination) AgentCombinationView {
	if library.recipesPath == "" {
		Raise("unsupported", "This runtime has no agent-combination file")
	}
	if combination.Mode == "main" && combination.Id != "main" {
		Raise("invalid_agent_combination", "The Main Agent recipe must use id \"main\"")
	}
	if combination.Resources == nil {
		combination.Resources = []AgentCombinationResource{}
	}
	if combination.Tags == nil {
		combination.Tags = []string{}
	}
	combined := []AgentCombination{}
	for _, item := range library.recipes {
		if item.Id != combination.Id {
			combined = append(combined, item)
		}
	}
	combined = append(combined, combination)
	document := ParseAgentCombinations(AgentCombinationDocument{Version: 1, Combinations: combined})
	next := document.Combinations
	view := ValidateAgentCombination(combination, library.capabilitiesCache)
	if view.Status != "valid" {
		Raise("invalid_agent_combination", strings.Join(view.Issues, "; "))
	}
	WriteAgentCombinations(library.recipesPath, AgentCombinationDocument{Version: document.Version, Combinations: next})
	library.recipes = next
	return ValidateAgentCombination(combination, library.capabilitiesCache)
}

// UpdateAgentCombinationDescription rewrites one recipe description.
func (library *CapabilityLibrary) UpdateAgentCombinationDescription(id string, description string) AgentCombinationView {
	if library.recipesPath == "" {
		Raise("unsupported", "This runtime has no agent-combination file")
	}
	current := AgentCombination{}
	found := false
	for _, item := range library.recipes {
		if item.Id == id {
			current = item
			found = true
			break
		}
	}
	if !found {
		Raise("not_found", "Unknown Agent combination "+id)
	}
	normalized := strings.TrimSpace(description)
	if normalized == "" {
		Raise("invalid_agent_combination", "Agent combination description must be a nonempty string")
	}
	if len([]rune(normalized)) > 2000 {
		Raise("invalid_agent_combination", "Agent combination description must be at most 2000 characters")
	}
	current.Description = normalized
	return library.SaveAgentCombination(current)
}

// DeleteAgentCombination removes one recipe.
func (library *CapabilityLibrary) DeleteAgentCombination(id string) DeletedAgentCombination {
	if library.recipesPath == "" {
		Raise("unsupported", "This runtime has no agent-combination file")
	}
	for _, item := range library.recipes {
		if item.Id == id && item.Mode == "main" {
			Raise("invalid_agent_combination", "The Main Agent recipe cannot be deleted")
		}
	}
	next := []AgentCombination{}
	for _, item := range library.recipes {
		if item.Id != id {
			next = append(next, item)
		}
	}
	if len(next) == len(library.recipes) {
		Raise("not_found", "Unknown Agent combination "+id)
	}
	WriteAgentCombinations(library.recipesPath, AgentCombinationDocument{Version: 1, Combinations: next})
	library.recipes = next
	return DeletedAgentCombination{Id: id, Deleted: true}
}

// CompileAgentCombination compiles one recipe into a definition spec.
func (library *CapabilityLibrary) CompileAgentCombination(id string) CompiledAgentCombination {
	combination := AgentCombination{}
	found := false
	for _, item := range library.recipes {
		if item.Id == id {
			combination = item
			found = true
			break
		}
	}
	if !found {
		Raise("not_found", "Unknown Agent combination "+id)
	}
	return CompileAgentCombinationDefinition(combination, library.capabilitiesCache)
}

// UpsertCapabilityBundle installs one capability bundle into the capability root.
func (library *CapabilityLibrary) UpsertCapabilityBundle(input CapabilityBundleInput) CapabilityBundleResult {
	if library.capabilityRoot == "" {
		Raise("unsupported", "This runtime has no writable capability directory")
	}
	manifest := ParseCapabilityManifest(input.Manifest, "<bundle>")
	files := input.Files
	if files == nil {
		files = map[string]string{}
	}
	capabilityBundleValidateFiles(manifest, files)

	directory := filepath.Join(library.capabilityRoot, capabilityBundleDirectories[manifest.Kind], manifest.Id+"-"+manifest.Version)
	for _, record := range library.capabilitiesCache {
		if record.Id != manifest.Id || record.Version != manifest.Version {
			continue
		}
		if capabilityBundleResolve(record.Source) == capabilityBundleResolve(directory) {
			continue
		}
		Raise("capability_exists", "Capability "+manifest.Id+"@"+manifest.Version+" is already registered from "+record.Source)
	}
	if _, err := os.Stat(directory); err == nil && !input.Overwrite {
		Raise("capability_exists", "Capability "+manifest.Id+"@"+manifest.Version+" is already installed; set overwrite=true only after explicit approval")
	}
	staging := directory + ".tmp-" + newUUID()
	if err := os.MkdirAll(staging, 0o700); err != nil {
		panic(err)
	}
	installed := false
	defer func() {
		if !installed {
			_ = os.RemoveAll(staging)
		}
	}()
	// TODO(port): TypeScript wrote the manifest keys in insertion order; Go sorts them.
	body, err := json.MarshalIndent(capabilityBundleManifestJSON(manifest), "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "capability.json"), append(body, '\n'), 0o600); err != nil {
		panic(err)
	}
	for path, content := range files {
		target := filepath.Join(staging, capabilityBundleSafePath(path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			panic(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
			panic(err)
		}
	}
	staged := ScanCapabilities(staging)
	valid := false
	invalid := CapabilityRecord{}
	hasInvalid := false
	for _, record := range staged {
		if record.Id == manifest.Id && record.Version == manifest.Version && record.Status == "available" {
			valid = true
		}
		if record.Status == "invalid" && !hasInvalid {
			invalid = record
			hasInvalid = true
		}
	}
	if !valid {
		reason := "Capability " + manifest.Id + "@" + manifest.Version + " did not pass catalog validation"
		if hasInvalid && invalid.Error != "" {
			reason = invalid.Error
		}
		Raise("invalid_capability", reason)
	}
	if _, err := os.Stat(directory); err == nil {
		if err := os.RemoveAll(directory); err != nil {
			panic(err)
		}
	}
	if err := os.Rename(staging, directory); err != nil {
		panic(err)
	}
	installed = true

	library.RefreshCapabilities()
	record := library.Capability(manifest.Id, manifest.Version)
	if record == nil || record.Status != "available" {
		reason := "Capability " + manifest.Id + "@" + manifest.Version + " did not pass catalog validation"
		if record != nil && record.Error != "" {
			reason = record.Error
		}
		Raise("invalid_capability", reason)
	}
	return CapabilityBundleResult{Capability: *record, Directory: directory}
}

// capabilityBundleResolve is the absolute path of a capability source.
func capabilityBundleResolve(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return absolute
}

// capabilityBundleSafePath rejects a bundle file path that leaves its directory.
func capabilityBundleSafePath(path string) string {
	if path == "" || filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		Raise("invalid_capability", "Capability bundle file paths must be relative")
	}
	normalized := capabilityBundlePrefix.ReplaceAllString(strings.ReplaceAll(path, "\\", "/"), "")
	for _, part := range strings.Split(normalized, "/") {
		if part == "" || part == "." || part == ".." {
			Raise("invalid_capability", "Capability bundle file paths cannot traverse directories")
		}
	}
	resolved, err := filepath.Rel(".", filepath.Join(".", normalized))
	if err != nil {
		Raise("invalid_capability", "Capability bundle file path escapes its directory")
	}
	if strings.HasPrefix(resolved, "..") || filepath.IsAbs(resolved) {
		Raise("invalid_capability", "Capability bundle file path escapes its directory")
	}
	return resolved
}

// capabilityBundleValidateFiles checks the bundle payload before anything is written.
func capabilityBundleValidateFiles(manifest CapabilityManifest, files map[string]string) {
	if len(files) > 64 {
		Raise("invalid_capability", "A capability bundle may contain at most 64 files")
	}
	bytes := 0
	for path, content := range files {
		normalized := capabilityBundleSafePath(path)
		if normalized == "capability.json" {
			Raise("invalid_capability", "capability.json is generated from the manifest")
		}
		bytes += len([]byte(content))
		if bytes > 2_000_000 {
			Raise("invalid_capability", "A capability bundle may contain at most 2 MB of text")
		}
	}
	for _, value := range manifest.Headers {
		if !capabilityBundleHeaderRef.MatchString(value) {
			Raise("invalid_capability", "Literal credential headers are not allowed; use headersEnv instead")
		}
	}
	if manifest.Kind == CapabilityKindSkill && strings.TrimSpace(files["SKILL.md"]) == "" {
		Raise("invalid_capability", "A skill bundle requires SKILL.md")
	}
	if manifest.Kind == CapabilityKindPrompt {
		name := "agent.md"
		if manifest.Role == "tool" {
			name = "tool.md"
		}
		if strings.TrimSpace(files[name]) == "" {
			Raise("invalid_capability", "A "+manifest.Role+" prompt bundle requires "+name)
		}
	}
	entry := manifest.Entry
	if entry == "" {
		entry = "./index.mjs"
	}
	entry = capabilityBundlePrefix.ReplaceAllString(entry, "")
	if (manifest.Kind == CapabilityKindExtension || manifest.Kind == CapabilityKindPiExtension) && strings.TrimSpace(files[entry]) == "" {
		Raise("invalid_capability", "An extension bundle requires "+entry)
	}
}

// capabilityBundleManifestJSON is the capability.json document the bundle installs. The
// manifest keeps every key it was given and the normalized values the parser produced.
func capabilityBundleManifestJSON(manifest CapabilityManifest) map[string]any {
	out := map[string]any{}
	for key, value := range manifest.Extra {
		out[key] = value
	}
	out["id"] = manifest.Id
	out["kind"] = manifest.Kind
	out["version"] = manifest.Version
	out["name"] = manifest.Name
	if manifest.Description != "" {
		out["description"] = manifest.Description
	}
	if manifest.Role != "" {
		out["role"] = manifest.Role
	}
	if manifest.Base {
		out["base"] = true
	}
	if manifest.Command != "" {
		out["command"] = manifest.Command
	}
	if manifest.Args != nil {
		out["args"] = manifest.Args
	}
	if manifest.Url != "" {
		out["url"] = manifest.Url
	}
	if manifest.Provisioning != nil {
		provisioning := map[string]any{"manager": manifest.Provisioning.Manager}
		if manifest.Provisioning.Domains != nil {
			provisioning["domains"] = manifest.Provisioning.Domains
		}
		out["provisioning"] = provisioning
	}
	if manifest.Headers != nil {
		out["headers"] = manifest.Headers
	}
	if manifest.HeadersEnv != nil {
		out["headersEnv"] = manifest.HeadersEnv
	}
	if manifest.NetworkDomains != nil {
		out["networkDomains"] = manifest.NetworkDomains
	}
	if manifest.NetworkAccess != "" {
		out["networkAccess"] = manifest.NetworkAccess
	}
	if manifest.Entry != "" {
		out["entry"] = manifest.Entry
	}
	if manifest.Tools != nil {
		tools := make([]map[string]any, 0, len(manifest.Tools))
		for _, tool := range manifest.Tools {
			entry := map[string]any{"name": tool.Name}
			if tool.Description != "" {
				entry["description"] = tool.Description
			}
			tools = append(tools, entry)
		}
		out["tools"] = tools
	}
	if manifest.Runtime != nil {
		runtime := map[string]any{}
		if manifest.Runtime.Commands != nil {
			runtime["commands"] = manifest.Runtime.Commands
		}
		if manifest.Runtime.Env != nil {
			runtime["env"] = manifest.Runtime.Env
		}
		if manifest.Runtime.ReadPaths != nil {
			runtime["readPaths"] = manifest.Runtime.ReadPaths
		}
		if manifest.Runtime.WritePaths != nil {
			runtime["writePaths"] = manifest.Runtime.WritePaths
		}
		if manifest.Runtime.NetworkDomains != nil {
			runtime["networkDomains"] = manifest.Runtime.NetworkDomains
		}
		if manifest.Runtime.NetworkAccess != "" {
			runtime["networkAccess"] = manifest.Runtime.NetworkAccess
		}
		if manifest.Runtime.AllowLocalBinding != nil {
			runtime["allowLocalBinding"] = *manifest.Runtime.AllowLocalBinding
		}
		if manifest.Runtime.UnixSockets != nil {
			runtime["unixSockets"] = manifest.Runtime.UnixSockets
		}
		out["runtime"] = runtime
	}
	if manifest.Tags != nil {
		out["tags"] = manifest.Tags
	}
	return out
}
