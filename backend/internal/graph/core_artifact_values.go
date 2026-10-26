package graph

import (
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const artifactVisibleTasks = "(id=? OR (conversation_id IS NOT NULL AND conversation_id=(SELECT conversation_id FROM tasks WHERE id=?)))"

var (
	artifactSlugPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
	artifactTagPattern    = regexp.MustCompile(`^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$`)
	artifactSchemaPattern = regexp.MustCompile(`^([a-z][a-z0-9._-]*)@([1-9]\d*)$`)
	artifactMIMEPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`)
	artifactCodeExt       = regexp.MustCompile(`\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|java|swift|sh)$`)
)

func artifactWorkspaceWithin(root, target string) bool {
	sep := string(os.PathSeparator)
	if root == sep {
		return strings.HasPrefix(target, sep)
	}
	return target == root || strings.HasPrefix(target, root+sep)
}

func artifactRequiredText(value, field string, max int) string {
	if strings.TrimSpace(value) == "" || utf16Len(value) > max {
		Raise("invalid_artifact", field+" must be a nonempty string of at most "+itoa(max)+" characters")
	}
	return strings.TrimSpace(value)
}

func artifactOptionalText(value, field string, max int, present bool) *string {
	if !present {
		return nil
	}
	text := artifactRequiredText(value, field, max)
	return &text
}

func artifactWorkspaceSlug(value, field string) string {
	normalized := strings.ToLower(artifactRequiredText(value, field, 120))
	if !artifactSlugPattern.MatchString(normalized) {
		Raise("invalid_artifact", field+" must be a lowercase slug")
	}
	return normalized
}

func artifactParseSchema(value string, present bool) (kind *string, version *int) {
	if !present {
		return nil, nil
	}
	match := artifactSchemaPattern.FindStringSubmatch(value)
	if match == nil {
		Raise("invalid_artifact", "schema must use kind@version syntax")
	}
	number, _ := strconv.Atoi(match[2])
	return &match[1], &number
}

func artifactTag(value, field string) string {
	normalized := strings.ToLower(artifactRequiredText(value, field, 60))
	if !artifactTagPattern.MatchString(normalized) {
		Raise("invalid_artifact", field+" must be a label of letters, digits, dot, dash or underscore in any script (at most 60 characters)")
	}
	return normalized
}

func artifactNormalizeTags(value []string) []string {
	seen := map[string]bool{}
	tags := []string{}
	for _, entry := range value {
		tag := artifactTag(entry, "tag")
		if seen[tag] {
			continue
		}
		seen[tag] = true
		tags = append(tags, tag)
	}
	sort.Slice(tags, func(i, j int) bool { return lessByByteOrder(tags[i], tags[j]) })
	if len(tags) > 20 {
		Raise("invalid_artifact", "An artifact may have at most 20 tags")
	}
	return tags
}

func artifactURI(scope ArtifactScope, ownerId, namespace, name string, version int) string {
	owner := "projects"
	if scope == "task" {
		owner = "tasks"
	}
	return "graph://" + owner + "/" + encodeURIComponent(ownerId) + "/artifacts/" + encodeURIComponent(namespace) + "/" + encodeURIComponent(name) + "@" + itoa(version)
}

func artifactTruthy(value any) bool {
	if value == nil {
		return false
	}
	text, ok := value.(string)
	return !ok || text != ""
}

func artifactOptionalString(value any) *string {
	if value == nil {
		return nil
	}
	text := kernelString(value)
	if text == "" && value != "" {
		if _, ok := value.(string); !ok {
			return nil
		}
	}
	return &text
}
