package graph

import (
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"crypto/sha256"
)

// ResolvedAccessPolicy is an access policy bound to one host: the policy
// itself plus the authorization it was granted under, the paths it protects,
// and the digest of that authorization.
type ResolvedAccessPolicy struct {
	AccessPolicy
	Authorization  string   `json:"authorization"`
	ProtectedPaths []string `json:"protectedPaths"`
	Digest         string   `json:"digest"`
}

// AccessPolicyContext names the host directories a policy is resolved against.
// An empty field means the host default.
type AccessPolicyContext struct {
	Home      string
	StateDir  string
	GraphHome string
}

// accessPolicyBody is the object the policy digest is computed over. It is
// the policy without its own digest, exactly as the TypeScript spread was.
type accessPolicyBody struct {
	AccessPolicy
	Authorization  string   `json:"authorization"`
	ProtectedPaths []string `json:"protectedPaths"`
}

// accessPolicyWiderValues are the values that only ever widen a grant.
var accessPolicyWiderValues = []string{"full", "host", "unrestricted", "writable", "readable", "all"}

// DefaultAccessPolicy is the only policy: Graph trusts the host completely.
func DefaultAccessPolicy() AccessPolicy { return FullAccessPolicy() }// ParseAccessPolicy parses one optional access document. Missing fields inherit
// ParseAccessPolicy ignores the document. Graph has one permission posture, so an
// absent, partial or explicit document cannot change what a session may touch.
func ParseAccessPolicy(value any, path string) AccessPolicy {
	return FullAccessPolicy()
}// CredentialProtectPaths lists the credential stores a protected policy hides.
func CredentialProtectPaths(home string) []string {
	paths := []string{
		".ssh",
		".aws",
		".azure",
		".config/gh",
		".config/gcloud",
		".docker/config.json",
		".git-credentials",
		".netrc",
		".npmrc",
		".pypirc",
	}
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, filepath.Join(home, path))
	}
	return out
}

// ResolveAccessPolicy returns the one policy, with no protected paths and the
// bypass authorization the digest used to distinguish.
func ResolveAccessPolicy(value AccessPolicy, context AccessPolicyContext) *ResolvedAccessPolicy {
	policy := FullAccessPolicy()
	resolved := &ResolvedAccessPolicy{AccessPolicy: policy, Authorization: "bypass"}
	// The digest still names the policy an operation ran under: it is how a
	// refusal says which posture it read, even when there is only one.
	resolved.Digest = accessPolicyDigest(accessPolicyBody{AccessPolicy: policy, Authorization: resolved.Authorization})
	return resolved
}// IsHostRead is always true: the whole host is readable.
func IsHostRead(policy *ResolvedAccessPolicy) bool { return true }// IsHostWrite reports whether the policy writes the whole host.
// IsHostWrite is always true: the whole host is writable.
func IsHostWrite(policy *ResolvedAccessPolicy) bool { return true }// IsFullAccess reports whether the policy is the full-access mode.
// IsFullAccess is always true: there is one posture.
func IsFullAccess(policy *ResolvedAccessPolicy) bool { return true }// NodeAccessPolicy lets a node pick its own policy only within the already
// authorized host policy.
func NodeAccessPolicy(value any, ceiling *ResolvedAccessPolicy, context AccessPolicyContext) *ResolvedAccessPolicy {
	host := DefaultAccessPolicy()
	if ceiling != nil {
		host = ceiling.AccessPolicy
	}
	if value == nil {
		return ceiling
	}
	requested := ParseAccessPolicy(value, "node.access")
	accessPolicyWider(requested, host, "node.access")
	resolved := ResolveAccessPolicy(requested, context)
	unique := map[string]bool{}
	for _, path := range resolved.ProtectedPaths {
		unique[path] = true
	}
	if ceiling != nil {
		for _, path := range ceiling.ProtectedPaths {
			unique[path] = true
		}
	}
	paths := make([]string, 0, len(unique))
	for path := range unique {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	effective := &ResolvedAccessPolicy{
		AccessPolicy:   resolved.AccessPolicy,
		Authorization:  resolved.Authorization,
		ProtectedPaths: paths,
	}
	effective.Digest = accessPolicyDigest(accessPolicyBody{
		AccessPolicy:   requested,
		Authorization:  effective.Authorization,
		ProtectedPaths: paths,
	})
	return effective
}

func accessPolicyDigest(body accessPolicyBody) string {
	sum := sha256.Sum256([]byte(CanonicalJSON(body)))
	return hex.EncodeToString(sum[:])
}

func accessPolicyObject(value any, path string) map[string]any {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		Raise("invalid_config", path+" must be an object")
	}
	return record
}

func accessPolicyEnum(value any, allowed []string, path string) string {
	text, ok := value.(string)
	if !ok || !containsString(allowed, text) {
		Raise("invalid_config", path+" must be one of "+strings.Join(allowed, ", "))
	}
	return text
}

func accessPolicyBoolean(value any, path string) bool {
	flag, ok := value.(bool)
	if !ok {
		Raise("invalid_config", path+" must be a boolean")
	}
	return flag
}

func accessPolicyOptionalEnum(record map[string]any, key string, allowed []string, fallback, path string) string {
	value, ok := record[key]
	if !ok {
		return fallback
	}
	return accessPolicyEnum(value, allowed, path)
}

func accessPolicyOptionalBool(record map[string]any, key string, fallback bool, path string) bool {
	value, ok := record[key]
	if !ok {
		return fallback
	}
	return accessPolicyBoolean(value, path)
}

// accessPolicyWider rejects a requested field that widens the host grant. The
// fields are read in the policy's own key order, so the first refusal names
// the same field the TypeScript walk refused.
func accessPolicyWider(requested AccessPolicy, ceiling AccessPolicy, path string) {
	accessPolicyWiderField(requested.Mode, ceiling.Mode, path+".mode")
	accessPolicyWiderField(requested.AutoApprove.Permission, ceiling.AutoApprove.Permission, path+".autoApprove.permission")
	accessPolicyWiderField(requested.AutoApprove.SystemChange, ceiling.AutoApprove.SystemChange, path+".autoApprove.systemChange")
	accessPolicyWiderField(requested.Filesystem.Read, ceiling.Filesystem.Read, path+".filesystem.read")
	accessPolicyWiderField(requested.Filesystem.Write, ceiling.Filesystem.Write, path+".filesystem.write")
	accessPolicyWiderField(requested.Filesystem.GitMetadata, ceiling.Filesystem.GitMetadata, path+".filesystem.gitMetadata")
	accessPolicyWiderField(requested.Filesystem.CredentialStores, ceiling.Filesystem.CredentialStores, path+".filesystem.credentialStores")
	accessPolicyWiderField(requested.Network, ceiling.Network, path+".network")
	accessPolicyWiderField(requested.Commands, ceiling.Commands, path+".commands")
	accessPolicyWiderField(requested.PiExtensions.Runtime, ceiling.PiExtensions.Runtime, path+".piExtensions.runtime")
	accessPolicyWiderField(requested.PiExtensions.LocalBinding, ceiling.PiExtensions.LocalBinding, path+".piExtensions.localBinding")
	accessPolicyWiderField(requested.PiExtensions.UnixSockets, ceiling.PiExtensions.UnixSockets, path+".piExtensions.unixSockets")
	accessPolicyWiderField(requested.PiExtensions.AppleEvents, ceiling.PiExtensions.AppleEvents, path+".piExtensions.appleEvents")
}

// accessPolicyWiderField refuses one field that widens the host grant.
func accessPolicyWiderField(candidate any, allowed any, path string) {
	if accessPolicySame(candidate, allowed) {
		return
	}
	if flag, ok := candidate.(bool); ok && flag {
		Raise("permission", path+" exceeds the host authorization ("+accessPolicyText(allowed)+")")
	}
	if containsString(accessPolicyWiderValues, accessPolicyText(candidate)) {
		Raise("permission", path+" exceeds the host authorization ("+accessPolicyText(allowed)+")")
	}
}

func accessPolicySame(left, right any) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	leftRecord, leftIsRecord := left.(map[string]any)
	rightRecord, rightIsRecord := right.(map[string]any)
	if leftIsRecord || rightIsRecord {
		if !leftIsRecord || !rightIsRecord {
			return false
		}
		if len(leftRecord) != len(rightRecord) {
			return false
		}
		for key, value := range leftRecord {
			other, ok := rightRecord[key]
			if !ok || !accessPolicySame(value, other) {
				return false
			}
		}
		return true
	}
	leftList, leftIsList := left.([]any)
	rightList, rightIsList := right.([]any)
	if leftIsList || rightIsList {
		if !leftIsList || !rightIsList || len(leftList) != len(rightList) {
			return false
		}
		for index, value := range leftList {
			if !accessPolicySame(value, rightList[index]) {
				return false
			}
		}
		return true
	}
	return left == right
}

// accessPolicyText is the JavaScript String() of one policy value.
func accessPolicyText(value any) string {
	switch typed := value.(type) {
	case nil:
		return "undefined"
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case AccessMode:
		return string(typed)
	case AccessRead:
		return string(typed)
	case AccessWrite:
		return string(typed)
	case AccessNetwork:
		return string(typed)
	case AccessCommands:
		return string(typed)
	case ExtensionRuntime:
		return string(typed)
	case UnixSocketAccess:
		return string(typed)
	case ProtectedStoreAccess:
		return string(typed)
	case GitMetadataAccess:
		return string(typed)
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(typed)
	}
}
