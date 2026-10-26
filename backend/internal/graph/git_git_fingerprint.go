package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type gitStatusRecord struct {
	Code     string
	Path     string
	OrigPath string
}

func parseStatus(raw string) []gitStatusRecord {
	fields := strings.Split(raw, "\x00")
	records := []gitStatusRecord{}
	for index := 0; index < len(fields); index++ {
		field := fields[index]
		if field == "" {
			continue
		}
		code := field
		if len(field) >= 2 {
			code = field[:2]
		}
		path := ""
		if len(field) > 3 {
			path = field[3:]
		}
		if len(code) > 0 && (code[0] == 'R' || code[0] == 'C') {
			original := ""
			if index+1 < len(fields) {
				original = fields[index+1]
			}
			index++
			records = append(records, gitStatusRecord{Code: code, Path: path, OrigPath: original})
		} else if path != "" {
			records = append(records, gitStatusRecord{Code: code, Path: path})
		}
	}
	return records
}

func gitScopeOf(subdir string) string {
	if subdir != "" {
		return subdir
	}
	return "."
}

func gitStateRel(repo, stateDir string) *string {
	if stateDir != "" && PathInside(repo, stateDir) {
		value := filepath.ToSlash(relPath(repo, gitReal(stateDir)))
		return &value
	}
	return nil
}

func gitInScope(path, scope string) bool {
	return scope == "." || path == scope || strings.HasPrefix(path, scope+"/")
}

func scopedStatus(repo, subdir, stateDir string) []gitStatusRecord {
	scope := gitScopeOf(subdir)
	stateRel := gitStateRel(repo, stateDir)
	raw := GitRaw(repo, []string{"status", "--porcelain=v1", "-z", "-uall", "--", scope}, nil, nil).Stdout
	out := []gitStatusRecord{}
	for _, record := range parseStatus(raw) {
		if !gitInScope(record.Path, scope) || BaselineExcluded(record.Path, stateRel) {
			continue
		}
		if record.OrigPath != "" && !gitInScope(record.OrigPath, scope) {
			continue
		}
		out = append(out, record)
	}
	return out
}

// BaselineFiles is the explicit candidate list for a scoped baseline.
func BaselineFiles(repo, subdir, stateDir string) []string {
	paths := map[string]bool{}
	order := []string{}
	add := func(path string) {
		if path == "" || paths[path] {
			return
		}
		paths[path] = true
		order = append(order, path)
	}
	for _, record := range scopedStatus(repo, subdir, stateDir) {
		add(record.Path)
		add(record.OrigPath)
	}
	sort.Strings(order)
	return order
}

// ScopedDirty lists dirty entries a scoped baseline cannot capture.
func ScopedDirty(repo, subdir, stateDir string) []string {
	out := []string{}
	for _, record := range scopedStatus(repo, subdir, stateDir) {
		line := record.Code + " " + record.Path
		if record.OrigPath != "" {
			line += " <- " + record.OrigPath
		}
		out = append(out, line)
	}
	return out
}

// RepoFingerprint is the readiness fingerprint of a repository scope.
func RepoFingerprint(repo, subdir, stateDir string) string {
	records := scopedStatus(repo, subdir, stateDir)
	existing := []string{}
	for _, record := range records {
		if _, err := os.Stat(filepath.Join(repo, record.Path)); err == nil {
			existing = append(existing, record.Path)
		}
	}
	hashes := ""
	if len(existing) > 0 {
		joined := strings.Join(existing, "\n")
		hashes = Git(repo, []string{"hash-object", "--stdin-paths"}, &joined, nil).Stdout
	}
	parts := []string{}
	for _, record := range records {
		line := record.Code + " " + record.Path
		if record.OrigPath != "" {
			line += " " + record.OrigPath
		}
		parts = append(parts, line)
	}
	status := strings.Join(parts, "\x00")
	head := ""
	if parsed := RevParse(repo, "HEAD"); parsed != nil {
		head = *parsed
	}
	branch := ""
	if checked := CheckedOutBranch(repo); checked != nil {
		branch = *checked
	}
	sum := sha256.Sum256([]byte("head=" + head + "\nbranch=" + branch + "\nstatus=" + status + "\nblobs=" + hashes))
	return hex.EncodeToString(sum[:])
}
