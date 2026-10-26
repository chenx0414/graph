package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DirectoryFingerprint fingerprints a directory that is not a Git repository.
func DirectoryFingerprint(root, stateDir string) string {
	stateRel := gitStateRel(root, stateDir)
	hash := sha256.New()
	count := 0
	var walk func(dir, base string)
	walk = func(dir, base string) {
		if count > 5000 {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			rel := entry.Name()
			if base != "" {
				rel = base + "/" + entry.Name()
			}
			if BaselineExcluded(rel, stateRel) {
				continue
			}
			if entry.IsDir() {
				walk(filepath.Join(dir, entry.Name()), rel)
				continue
			}
			info, err := entry.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			count++
			hash.Write([]byte(rel))
			hash.Write([]byte{0})
			body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				hash.Write([]byte("unreadable"))
			} else {
				hash.Write(body)
			}
			hash.Write([]byte{0})
		}
	}
	walk(root, "")
	return "dir:" + itoa(count) + ":" + hex.EncodeToString(hash.Sum(nil))
}

// InitRepo creates a hermetic repository on main, then writes host excludes.
func InitRepo(root string) {
	result := Git(root, []string{"init", "--template=", "-b", "main"}, nil, nil)
	if result.Code != 0 {
		fallback := Git(root, []string{"init", "--template="}, nil, nil)
		if fallback.Code != 0 {
			message := fallback.Stderr
			if message == "" {
				message = result.Stderr
			}
			if message == "" {
				message = "git init failed"
			}
			panic(gitError(message))
		}
	}
	EnsureHostExcludes(root, nil)
}

// CommitBaseline commits exactly the given scope, never the whole index.
func CommitBaseline(cwd, message, subdir, stateDir string) string {
	var extra []string
	if stateRel := gitStateRel(cwd, stateDir); stateRel != nil {
		extra = []string{*stateRel + "/"}
	}
	EnsureHostExcludes(cwd, extra)
	head := RevParse(cwd, "HEAD")
	files := BaselineFiles(cwd, subdir, stateDir)
	if len(files) == 0 {
		if head != nil {
			return *head
		}
		empty := Git(cwd, []string{"hash-object", "-t", "tree", "/dev/null"}, nil, nil)
		created := Git(cwd, []string{"commit-tree", empty.Stdout, "-m", message}, nil, nil)
		if created.Code != 0 || created.Stdout == "" {
			text := created.Stderr
			if text == "" {
				text = "Baseline commit failed"
			}
			panic(gitError(text))
		}
		update := Git(cwd, []string{"update-ref", "HEAD", created.Stdout}, nil, nil)
		if update.Code != 0 {
			text := update.Stderr
			if text == "" {
				text = "Baseline ref update failed"
			}
			panic(gitError(text))
		}
		return created.Stdout
	}
	list := filepath.Join(filepath.Dir(filepath.Join(cwd, ".graph-tmp")), ".graph-baseline-"+itoa(os.Getpid())+"-"+itoa(int(NowMillis())))
	if err := os.WriteFile(list, []byte(strings.Join(files, "\x00")+"\x00"), 0o600); err != nil {
		panic(err)
	}
	defer os.Remove(list)
	present := []string{}
	for _, file := range files {
		if _, err := os.Stat(filepath.Join(cwd, file)); err == nil {
			present = append(present, file)
		}
	}
	if len(present) > 0 {
		added := Git(cwd, []string{"add", "-A", "--pathspec-from-file=" + list, "--pathspec-file-nul"}, nil, nil)
		if added.Code != 0 {
			fallback := Git(cwd, append([]string{"add", "--"}, present...), nil, nil)
			if fallback.Code != 0 {
				text := fallback.Stderr
				if text == "" {
					text = "Baseline add failed"
				}
				panic(gitError(text))
			}
		}
	}
	committed := Git(cwd, []string{"commit", "--no-verify", "-m", message, "--pathspec-from-file=" + list, "--pathspec-file-nul"}, nil, nil)
	if committed.Code != 0 {
		text := committed.Stderr
		if text == "" {
			text = "Baseline commit failed"
		}
		panic(gitError(text))
	}
	parsed := RevParse(cwd, "HEAD")
	if parsed == nil {
		panic(gitError("Baseline commit failed"))
	}
	return *parsed
}
