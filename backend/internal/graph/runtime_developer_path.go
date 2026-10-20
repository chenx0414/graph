package graph

import (
	"os"
	"strings"
)

// DEVELOPER_PATH_DIRECTORIES are locations a developer's shell puts on PATH
// but a desktop launch does not.
var DEVELOPER_PATH_DIRECTORIES = []string{"/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/sbin", "/usr/local/sbin"}

func developerPathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// DeveloperPath keeps the inherited order, then appends standard developer locations that exist.
func DeveloperPath(inherited string, exists ...func(string) bool) string {
	check := developerPathExists
	if len(exists) > 0 && exists[0] != nil {
		check = exists[0]
	}
	var directories []string
	if inherited != "" {
		for _, directory := range splitPath(inherited) {
			if directory != "" {
				directories = append(directories, directory)
			}
		}
	}
	for _, directory := range DEVELOPER_PATH_DIRECTORIES {
		if !pathContains(directories, directory) && check(directory) {
			directories = append(directories, directory)
		}
	}
	return joinPath(directories)
}

// WidenProcessPath widens one process environment's PATH in place.
// A nil env updates the process environment, matching the no-argument TypeScript call.
func WidenProcessPath(env map[string]string, exists ...func(string) bool) map[string]string {
	process := env == nil
	if process {
		env = environMap()
	}
	widened := DeveloperPath(env["PATH"], exists...)
	if widened != env["PATH"] {
		env["PATH"] = widened
		if process {
			_ = os.Setenv("PATH", widened)
		}
	}
	return env
}

func splitPath(value string) []string {
	return splitByte(value, ':')
}

func splitByte(value string, sep byte) []string {
	var out []string
	start := 0
	for i := 0; i < len(value); i++ {
		if value[i] == sep {
			out = append(out, value[start:i])
			start = i + 1
		}
	}
	out = append(out, value[start:])
	return out
}

func pathContains(directories []string, directory string) bool {
	for _, item := range directories {
		if item == directory {
			return true
		}
	}
	return false
}

func joinPath(directories []string) string {
	out := ""
	for i, directory := range directories {
		if i > 0 {
			out += ":"
		}
		out += directory
	}
	return out
}

func environMap() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			env[key] = value
		}
	}
	return env
}
