package graph

import (
	"path/filepath"
	"strings"
)

// The Pi extensions a request binds, and how a refusal names them.
//
// The PiG kernel hosts Graph's own tools and the native MCP channel. It hosts
// no Pi extension: PiG's extension model is a subprocess wire, and Graph's
// durable harness does not reach it. A capability that binds a Pi extension
// therefore cannot be honored on this kernel - and the honest answer to that
// is a refusal that names the capability, not a session that quietly runs
// without the tools the model was promised.

// piExtensionBindingNames names the Pi extension capabilities one request bound.
//
// A refusal a user can act on has to point at the capability to unbind. A
// path would not do that: a path is machine detail that moves between runs,
// and a path can hold any string at all - including one the retry classifier
// reads as a network error, which would turn a permanent refusal into a retry
// loop.
func piExtensionBindingNames(descriptor any, paths []string) []string {
	names := []string{}
	for _, fact := range asSlice(asMap(descriptor)["facts"]) {
		entry := asMap(fact)
		if mapString(entry, "kind", "Kind") != string(CapabilityKindPiExtension) {
			continue
		}
		id := strings.TrimSpace(mapString(entry, "id", "Id"))
		if id == "" {
			continue
		}
		version := strings.TrimSpace(mapString(entry, "version", "Version"))
		if version != "" {
			id = id + "@" + version
		}
		names = append(names, id)
	}
	if len(names) > 0 {
		return capabilityUniqueStrings(names)
	}
	// No fact names the extension. The path's own last two segments still say
	// which package it is, without the volatile directory above it.
	for _, path := range paths {
		name := piExtensionPathName(path)
		if name != "" {
			names = append(names, name)
		}
	}
	return capabilityUniqueStrings(names)
}

// piExtensionPathName is the readable name of one extension path.
func piExtensionPathName(path string) string {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return ""
	}
	directory := filepath.Base(filepath.Dir(cleaned))
	name := filepath.Base(cleaned)
	if directory == "." || directory == string(filepath.Separator) {
		return name
	}
	return directory + "/" + name
}

// piExtensionRefusalText is what a user reads when a bound Pi extension
// cannot run.
//
// The turn never reached the model, so the agent did not start: this is a
// setup failure, and the runtime words it as one. The reason says which
// capability to unbind.
func piExtensionRefusalText(descriptor any, paths []string) string {
	text := "A bound Pi extension cannot be hosted by the PiG kernel: the kernel runs Graph's own tools and the native MCP channel, but no Pi extension."
	names := piExtensionBindingNames(descriptor, paths)
	if len(names) > 0 {
		text += " Unbind " + strings.Join(names, ", ") + " to run this agent."
	}
	return text
}
