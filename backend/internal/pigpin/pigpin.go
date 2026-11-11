package pigpin

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const Module = "github.com/MichaelKinsy/PiG"

var (
	pinPattern = regexp.MustCompile(`(?m)^(\s*(?:require\s+)?)` + regexp.QuoteMeta(Module) + `\s+(v\S+)`)
	versionOK  = regexp.MustCompile(`^v\d+\.\d+\.\d+`)
)

func PinnedVersion(goMod []byte) (string, bool) {
	match := pinPattern.FindSubmatch(goMod)
	if match == nil {
		return "", false
	}
	return string(match[2]), true
}

func WritePin(goMod []byte, version string) ([]byte, error) {
	if pinPattern.Match(goMod) {
		return pinPattern.ReplaceAll(goMod, []byte("${1}"+Module+" "+version)), nil
	}
	lines := strings.Split(string(goMod), "\n")
	moduleLine := -1
	for index, line := range lines {
		if strings.HasPrefix(line, "module ") {
			moduleLine = index
			break
		}
	}
	if moduleLine < 0 {
		return nil, errors.New("backend/go.mod has no module line")
	}
	inserted := append([]string{}, lines[:moduleLine+1]...)
	inserted = append(inserted, "", "require "+Module+" "+version)
	inserted = append(inserted, lines[moduleLine+1:]...)
	return []byte(strings.Join(inserted, "\n")), nil
}

func CompareVersions(left, right string) int {
	leftCore, leftPre := splitVersion(left)
	rightCore, rightPre := splitVersion(right)
	for index := 0; index < len(leftCore) || index < len(rightCore); index++ {
		difference := partAt(leftCore, index) - partAt(rightCore, index)
		if difference != 0 {
			return difference
		}
	}
	if leftPre == rightPre {
		return 0
	}
	if leftPre == "" {
		return 1
	}
	if rightPre == "" {
		return -1
	}
	return strings.Compare(leftPre, rightPre)
}

func splitVersion(value string) ([]int, string) {
	trimmed := strings.TrimPrefix(value, "v")
	core, pre, found := strings.Cut(trimmed, "-")
	parts := []int{}
	for _, field := range strings.Split(core, ".") {
		number, _ := strconv.Atoi(field)
		parts = append(parts, number)
	}
	if !found {
		return parts, ""
	}
	return parts, pre
}

func partAt(parts []int, index int) int {
	if index >= len(parts) {
		return 0
	}
	return parts[index]
}

func ParseVersions(listOutput string) []string {
	lines := strings.Split(strings.TrimSpace(listOutput), "\n")
	fields := strings.Fields(strings.TrimSpace(lines[len(lines)-1]))
	if len(fields) <= 1 {
		return nil
	}
	return fields[1:]
}

func LatestStable(versions []string) (string, bool) {
	stable := []string{}
	for _, version := range versions {
		if !strings.Contains(version, "-") {
			stable = append(stable, version)
		}
	}
	if len(stable) == 0 {
		stable = versions
	}
	if len(stable) == 0 {
		return "", false
	}
	return stable[len(stable)-1], true
}

func IsVersion(value string) bool {
	return versionOK.MatchString(value)
}
