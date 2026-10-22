package graph

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const boundedGitMetadata = ".git"

// BoundedPathOptions names the host grants around a workspace root.
// allowSymlinks is accepted and unused, matching the TypeScript options object.
type BoundedPathOptions struct {
	AllowGitMetadata             bool
	AllowSymlinks                bool
	ProtectedPaths               []string
	ProtectedReadPathExceptions  []string
	ProtectedWritePathExceptions []string
}

func boundedOutside() {
	panic(errors.New("Path is outside the workspace"))
}

func boundedPathWithin(root, target string) bool {
	sep := string(os.PathSeparator)
	if root == sep {
		return len(target) > 0 && target[:1] == sep
	}
	return target == root || (len(target) > len(root) && target[:len(root)] == root && target[len(root):len(root)+1] == sep)
}

func boundedProtected(target string, protectedPaths, exceptions []string) bool {
	for _, path := range protectedPaths {
		if !boundedPathWithin(path, target) {
			continue
		}
		granted := false
		for _, exception := range exceptions {
			if boundedPathWithin(exception, target) {
				granted = true
				break
			}
		}
		if !granted {
			return true
		}
	}
	return false
}

// boundedContainsGit mirrors the TypeScript check: the path is split on the
// separator and any component that is exactly the Git metadata name counts.
func boundedContainsGit(target string) bool {
	for _, part := range strings.Split(target, string(filepath.Separator)) {
		if part == boundedGitMetadata {
			return true
		}
	}
	return false
}

func boundedErrno(err error, code syscall.Errno) bool {
	return errors.Is(err, code)
}

func boundedNlink(info os.FileInfo) uint64 {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat == nil {
		return 1
	}
	return uint64(stat.Nlink)
}

// ResolveBounded resolves a relative path under a trusted root without following links.
func ResolveBounded(root, relative, mode string) string {
	if relative == "" || stringsContainsNull(relative) {
		panic(errors.New("A nonempty path is required"))
	}
	target := filepath.Clean(filepath.Join(root, relative))
	if !boundedPathWithin(root, target) {
		boundedOutside()
	}
	if target == root {
		return target
	}
	rest := target[len(root):]
	if len(rest) > 0 && rest[0] == os.PathSeparator {
		rest = rest[1:]
	}
	parts := splitPathParts(rest)
	current := root
	for index, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			boundedOutside()
		}
		if part == boundedGitMetadata {
			panic(errors.New("Git metadata cannot be accessed through workspace tools"))
		}
		current = filepath.Join(current, part)
		last := index == len(parts)-1
		info, err := os.Lstat(current)
		if err != nil {
			if !os.IsNotExist(err) {
				panic(err)
			}
			if mode == "read" || last {
				return target
			}
			if mkErr := os.Mkdir(current, 0o755); mkErr != nil && !boundedErrno(mkErr, syscall.EEXIST) {
				panic(mkErr)
			}
			info, err = os.Lstat(current)
			if err != nil {
				panic(err)
			}
		}
		if info.Mode()&os.ModeSymlink != 0 {
			panic(errors.New("Refusing to follow the symbolic link " + part))
		}
		if !last && !info.IsDir() {
			panic(errors.New("Not a directory: " + part))
		}
		if mode == "write" && last && info.Mode().IsRegular() && boundedNlink(info) > 1 {
			panic(errors.New("Refusing to overwrite a multiply-linked file"))
		}
		resolved, err := filepath.EvalSymlinks(current)
		if err != nil || resolved != current {
			panic(errors.New("Path changed while resolving " + part))
		}
	}
	return target
}

func stringsContainsNull(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] == 0 {
			return true
		}
	}
	return false
}

func splitPathParts(value string) []string {
	if value == "" {
		return nil
	}
	return stringsSplitPath(value)
}

func stringsSplitPath(value string) []string {
	parts := []string{}
	start := 0
	for i := 0; i < len(value); i++ {
		if value[i] == os.PathSeparator {
			parts = append(parts, value[start:i])
			start = i + 1
		}
	}
	parts = append(parts, value[start:])
	return parts
}

func resolveHostPath(path, mode string, options BoundedPathOptions) string {
	if path == "" || stringsContainsNull(path) {
		panic(errors.New("A nonempty path is required"))
	}
	if !filepath.IsAbs(path) {
		panic(errors.New("Host access requires an absolute path"))
	}
	requested := filepath.Clean(path)
	if !options.AllowGitMetadata && boundedContainsGit(requested) {
		panic(errors.New("Git metadata cannot be accessed through workspace tools"))
	}
	exceptions := options.ProtectedWritePathExceptions
	if mode == "read" {
		exceptions = append(append([]string{}, options.ProtectedReadPathExceptions...), options.ProtectedWritePathExceptions...)
	}
	if boundedProtected(requested, options.ProtectedPaths, exceptions) {
		panic(errors.New("Path is protected by the current access policy"))
	}
	target, err := filepath.EvalSymlinks(requested)
	if err != nil {
		if !os.IsNotExist(err) || mode == "read" {
			panic(err)
		}
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(requested))
		if parentErr != nil {
			panic(parentErr)
		}
		name := requested[len(filepath.Dir(requested)):]
		if len(name) > 0 && name[0] == os.PathSeparator {
			name = name[1:]
		}
		target = filepath.Join(parent, name)
	}
	if !options.AllowGitMetadata && boundedContainsGit(target) {
		panic(errors.New("Git metadata cannot be accessed through workspace tools"))
	}
	if boundedProtected(target, options.ProtectedPaths, exceptions) {
		panic(errors.New("Path is protected by the current access policy"))
	}
	return target
}

// ReadHost reads a host file as text.
func ReadHost(path string, options BoundedPathOptions) string {
	body := ReadHostBytes(path, options)
	return string(body)
}

// ReadHostBytes reads a host file.
func ReadHostBytes(path string, options BoundedPathOptions) []byte {
	target := resolveHostPath(path, "read", options)
	info, err := os.Lstat(target)
	if err != nil {
		panic(err)
	}
	if !info.Mode().IsRegular() {
		panic(errors.New("A file path is required"))
	}
	body, err := os.ReadFile(target)
	if err != nil {
		panic(err)
	}
	return body
}

// WriteHost writes a host file, refusing links and hard links.
func WriteHost(path, content string, options BoundedPathOptions) {
	target := resolveHostPath(path, "write", options)
	existing, err := os.Lstat(target)
	if err != nil && !os.IsNotExist(err) {
		panic(err)
	}
	if err == nil {
		if existing.Mode()&os.ModeSymlink != 0 {
			panic(errors.New("Path changed during write"))
		}
		if !existing.Mode().IsRegular() {
			panic(errors.New("A file path is required"))
		}
		if boundedNlink(existing) > 1 {
			panic(errors.New("Refusing to overwrite a multiply-linked file"))
		}
	} else if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
		panic(mkErr)
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		panic(err)
	}
}

// ListHost lists one host directory.
func ListHost(path string, options BoundedPathOptions) []string {
	names, _ := ListHostLimit(path, options, 0)
	return names
}

// ListHostLimit lists one host directory up to a limit.
//
// The entries are read in batches, so a directory with a hundred thousand
// files costs the memory of the limit and not of the directory. The second
// answer says whether the directory holds more entries than were returned.
// A limit of zero lists the whole directory.
func ListHostLimit(path string, options BoundedPathOptions, limit int) ([]string, bool) {
	target := resolveHostPath(path, "read", options)
	info, err := os.Lstat(target)
	if err != nil {
		panic(err)
	}
	if !info.IsDir() {
		panic(errors.New("Not a directory"))
	}
	return listDirectoryLimited(target, limit)
}

func openBounded(root, relative, mode string) *os.File {
	target := ResolveBounded(root, relative, mode)
	if target == root {
		panic(errors.New("A file path is required"))
	}
	flags := syscall.O_RDONLY | syscall.O_NOFOLLOW
	if mode == "write" {
		flags = syscall.O_WRONLY | syscall.O_CREAT | syscall.O_TRUNC | syscall.O_NOFOLLOW
	}
	file, err := os.OpenFile(target, flags, 0o644)
	if err != nil {
		if boundedErrno(err, syscall.ELOOP) {
			panic(errors.New("Refusing to follow a symbolic link"))
		}
		panic(err)
	}
	failed := true
	defer func() {
		if failed {
			_ = file.Close()
		}
	}()
	parent := filepath.Dir(target)
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil || resolved != parent {
		panic(errors.New("Path changed during open"))
	}
	opened, err := file.Stat()
	if err != nil {
		panic(err)
	}
	current, err := os.Lstat(target)
	if err != nil || current.Mode()&os.ModeSymlink != 0 || !sameFile(opened, current) {
		panic(errors.New("Path changed during open"))
	}
	if mode == "write" && boundedNlink(current) > 1 {
		panic(errors.New("Refusing to overwrite a multiply-linked file"))
	}
	failed = false
	return file
}

func sameFile(left, right os.FileInfo) bool {
	ls, lok := left.Sys().(*syscall.Stat_t)
	rs, rok := right.Sys().(*syscall.Stat_t)
	if !lok || !rok {
		return false
	}
	return ls.Dev == rs.Dev && ls.Ino == rs.Ino
}

// ReadBounded reads a workspace file as text.
func ReadBounded(root, relative string) string {
	return string(ReadBoundedBytes(root, relative))
}

// ReadBoundedBytes reads a workspace file.
func ReadBoundedBytes(root, relative string) []byte {
	file := openBounded(root, relative, "read")
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil {
		panic(err)
	}
	return body
}

// WriteBounded writes a workspace file.
func WriteBounded(root, relative, content string) {
	file := openBounded(root, relative, "write")
	defer file.Close()
	if _, err := file.Write([]byte(content)); err != nil {
		panic(err)
	}
}

// ListBounded lists a workspace directory. The root itself skips lstat.
func ListBounded(root, relative string) []string {
	names, _ := ListBoundedLimit(root, relative, 0)
	return names
}

// ListBoundedLimit lists a workspace directory up to a limit.
//
// The entries are read in batches, so a directory with a hundred thousand
// files costs the memory of the limit and not of the directory. The second
// answer says whether the directory holds more entries than were returned.
// A limit of zero lists the whole directory.
func ListBoundedLimit(root, relative string, limit int) ([]string, bool) {
	target := ResolveBounded(root, relative, "read")
	if target != root {
		info, err := os.Lstat(target)
		if err != nil {
			panic(err)
		}
		if !info.IsDir() {
			panic(errors.New("Not a directory"))
		}
	}
	return listDirectoryLimited(target, limit)
}

// listDirectoryLimited reads the entries of one directory up to a limit.
//
// The entries come back sorted: a directory is read in batches, and a batch
// is not in the order the directory holds. The listing a model reads is
// alphabetical, so it stays that way.
func listDirectoryLimited(target string, limit int) ([]string, bool) {
	directory, err := os.Open(target)
	if err != nil {
		panic(err)
	}
	defer directory.Close()
	names := []string{}
	more := false
	for {
		// A batch of entries is read at a time: the whole directory is never
		// in memory at once.
		batch, err := directory.ReadDir(256)
		for _, entry := range batch {
			if limit > 0 && len(names) >= limit {
				more = true
				break
			}
			names = append(names, entry.Name())
		}
		if more || err != nil {
			break
		}
		if len(batch) == 0 {
			break
		}
	}
	sort.Strings(names)
	return names, more
}
