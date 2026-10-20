package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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

// DefaultAccessPolicy is the policy a missing access document grants.
func DefaultAccessPolicy() AccessPolicy {
	return FullAccessPolicy()
}

// ParseAccessPolicy parses one optional access document. Missing fields inherit
// the mode's defaults, and a missing document inherits full access.
func ParseAccessPolicy(value any, path string) AccessPolicy {
	// TODO(port): TypeScript told an absent document (undefined) from an
	// explicit null. Go hands both over as nil, so an explicit null reads as
	// an absent document here instead of raising invalid_config.
	if value == nil {
		return DefaultAccessPolicy()
	}
	raw := accessPolicyObject(value, path)
	mode := AccessMode("full")
	if declared, ok := raw["mode"]; ok {
		mode = AccessMode(accessPolicyEnum(declared, []string{"standard", "full"}, path+".mode"))
	}
	defaults := FullAccessPolicy()
	if mode == "standard" {
		defaults = StandardAccessPolicy()
	}
	policy := AccessPolicy{
		Mode:         mode,
		AutoApprove:  defaults.AutoApprove,
		Filesystem:   defaults.Filesystem,
		Network:      defaults.Network,
		Commands:     defaults.Commands,
		PiExtensions: defaults.PiExtensions,
	}
	if declared, ok := raw["autoApprove"]; ok {
		auto := accessPolicyObject(declared, path+".autoApprove")
		policy.AutoApprove = AccessAutoApprove{
			Permission:   accessPolicyOptionalBool(auto, "permission", defaults.AutoApprove.Permission, path+".autoApprove.permission"),
			SystemChange: accessPolicyOptionalBool(auto, "systemChange", defaults.AutoApprove.SystemChange, path+".autoApprove.systemChange"),
		}
	}
	if declared, ok := raw["filesystem"]; ok {
		filesystem := accessPolicyObject(declared, path+".filesystem")
		policy.Filesystem = AccessFilesystem{
			Read:             AccessRead(accessPolicyOptionalEnum(filesystem, "read", []string{"workspace-and-bound", "host"}, string(defaults.Filesystem.Read), path+".filesystem.read")),
			Write:            AccessWrite(accessPolicyOptionalEnum(filesystem, "write", []string{"workspace-and-bound", "host"}, string(defaults.Filesystem.Write), path+".filesystem.write")),
			GitMetadata:      GitMetadataAccess(accessPolicyOptionalEnum(filesystem, "gitMetadata", []string{"protected", "writable"}, string(defaults.Filesystem.GitMetadata), path+".filesystem.gitMetadata")),
			CredentialStores: ProtectedStoreAccess(accessPolicyOptionalEnum(filesystem, "credentialStores", []string{"protected", "readable"}, string(defaults.Filesystem.CredentialStores), path+".filesystem.credentialStores")),
		}
	}
	if declared, ok := raw["network"]; ok {
		policy.Network = AccessNetwork(accessPolicyEnum(declared, []string{"declared", "unrestricted"}, path+".network"))
	}
	if declared, ok := raw["commands"]; ok {
		policy.Commands = AccessCommands(accessPolicyEnum(declared, []string{"allowlisted", "host"}, path+".commands"))
	}
	if declared, ok := raw["piExtensions"]; ok {
		extensions := accessPolicyObject(declared, path+".piExtensions")
		policy.PiExtensions = AccessPiExtensions{
			Runtime:      ExtensionRuntime(accessPolicyOptionalEnum(extensions, "runtime", []string{"declared", "host"}, string(defaults.PiExtensions.Runtime), path+".piExtensions.runtime")),
			LocalBinding: accessPolicyOptionalBool(extensions, "localBinding", defaults.PiExtensions.LocalBinding, path+".piExtensions.localBinding"),
			UnixSockets:  UnixSocketAccess(accessPolicyOptionalEnum(extensions, "unixSockets", []string{"declared", "all"}, string(defaults.PiExtensions.UnixSockets), path+".piExtensions.unixSockets")),
			AppleEvents:  accessPolicyOptionalBool(extensions, "appleEvents", defaults.PiExtensions.AppleEvents, path+".piExtensions.appleEvents"),
		}
	}
	return policy
}

// CredentialProtectPaths lists the credential stores a protected policy hides.
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

// ResolveAccessPolicy binds a policy to one host.
func ResolveAccessPolicy(value AccessPolicy, context AccessPolicyContext) *ResolvedAccessPolicy {
	policy := value
	home := context.Home
	if home == "" {
		resolved, err := os.UserHomeDir()
		if err != nil {
			panic(err)
		}
		home = resolved
	}
	protectedPaths := []string{}
	if policy.Mode != "full" {
		if policy.Filesystem.CredentialStores == "protected" {
			protectedPaths = append(protectedPaths, CredentialProtectPaths(home)...)
		}
		graphHome := context.GraphHome
		if graphHome == "" {
			graphHome = filepath.Join(home, ".graph")
		}
		stateDir := context.StateDir
		if stateDir == "" {
			stateDir = filepath.Join(home, ".local", "state", "graph")
		}
		protectedPaths = append(protectedPaths, graphHome, stateDir)
	}
	unique := map[string]bool{}
	for _, path := range protectedPaths {
		unique[filepath.Clean(path)] = true
	}
	paths := make([]string, 0, len(unique))
	for path := range unique {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	authorization := "standard"
	if policy.AutoApprove.Permission {
		authorization = "bypass"
	}
	resolved := &ResolvedAccessPolicy{
		AccessPolicy:   policy,
		Authorization:  authorization,
		ProtectedPaths: paths,
	}
	resolved.Digest = accessPolicyDigest(accessPolicyBody{
		AccessPolicy:   policy,
		Authorization:  authorization,
		ProtectedPaths: paths,
	})
	return resolved
}

// IsHostRead reports whether the policy reads the whole host.
func IsHostRead(policy *ResolvedAccessPolicy) bool {
	return policy != nil && policy.Filesystem.Read == "host"
}

// IsHostWrite reports whether the policy writes the whole host.
func IsHostWrite(policy *ResolvedAccessPolicy) bool {
	return policy != nil && policy.Filesystem.Write == "host"
}

// IsFullAccess reports whether the policy is the full-access mode.
func IsFullAccess(policy *ResolvedAccessPolicy) bool {
	return policy != nil && policy.Mode == "full"
}

// NodeAccessPolicy lets a node pick its own policy only within the already
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
