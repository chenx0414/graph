package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func capabilityLoadPiExtension(input CapabilityLoadInput, binding capabilityBinding, record *CapabilityRecord, snapshot string, state *capabilityLoadState) ([]RuntimeCapabilityLoadFact, any) {
	if _, err := os.Stat(snapshot); err != nil {
		Raise("capability_unavailable", "Pi extension "+binding.bound.Id+"@"+binding.bound.Version+" has no snapshot")
	}
	manifest := capabilityManifestOf(snapshot)
	declared := capabilityDeclaredToolsFromManifest(manifest)
	source := ""
	if value, ok := manifest["source"].(string); ok && strings.TrimSpace(value) != "" {
		source = strings.TrimSpace(value)
	}
	loadedEntry := ""
	if source != "" {
		resolved, err := ResolvePiExtensionSource(PiExtensionSourceInput{
			Source: source, Cwd: input.Workspace, AgentDir: PiExtensionCacheDir(input.Catalog),
		})
		if err != nil {
			Raise("capability_unavailable", err.Error())
		}
		state.piExtensionPaths = append(state.piExtensionPaths, resolved.Entries...)
		state.readRoots = append(state.readRoots, resolved.ReadRoots...)
		if len(resolved.Entries) > 0 {
			loadedEntry = resolved.Entries[0]
		}
		SyncCapabilityVersion(snapshot, resolved.Version)
	} else {
		declaredEntry := "./index.mjs"
		if value, ok := manifest["entry"].(string); ok && strings.TrimSpace(value) != "" {
			declaredEntry = value
		}
		entry := declaredEntry
		if !filepath.IsAbs(entry) {
			entry = filepath.Clean(filepath.Join(snapshot, entry))
		}
		if entry != snapshot && !strings.HasPrefix(entry, snapshot+string(filepath.Separator)) {
			Raise("capability_unavailable", "Pi extension entry "+declaredEntry+" must stay inside its snapshot")
		}
		if _, err := os.Stat(entry); err != nil {
			Raise("capability_unavailable", "Pi extension entry "+declaredEntry+" does not exist")
		}
		state.piExtensionPaths = append(state.piExtensionPaths, entry)
		state.readRoots = append(state.readRoots, snapshot)
		loadedEntry = entry
	}
	for _, tool := range declared {
		state.piExtensionTools = append(state.piExtensionTools, tool.Name)
	}
	runtime := capabilityResolvePiExtensionRuntime(manifest, snapshot, input.Workspace, input.ScratchDir, filepath.Dir(input.ScratchDir), input.Secrets)
	if runtime != nil {
		for name, value := range runtime.env {
			state.env[name] = value
		}
		for _, path := range append(append([]string{}, runtime.writePaths...), runtime.unixSockets...) {
			if err := os.MkdirAll(path, 0o700); err != nil {
				Raise("capability_unavailable", err.Error())
			}
		}
		state.readRoots = append(state.readRoots, runtime.readPaths...)
		state.writeRoots = append(state.writeRoots, runtime.writePaths...)
		state.runtimeNetworkDomains = capabilityUniqueStrings(append(state.runtimeNetworkDomains, runtime.networkDomains...))
		state.runtimeUnixSockets = capabilityUniqueStrings(append(state.runtimeUnixSockets, runtime.unixSockets...))
		if runtime.allowUnrestrictedNetwork {
			state.runtimeUnrestrictedNetwork = true
		}
		if runtime.allowLocalBinding {
			state.runtimeLocalBinding = true
		}
	}
	commandState := "无"
	if runtime != nil && runtime.env["PATH"] != "" {
		commandState = "已解析"
	}
	networkState := "无"
	if runtime != nil {
		if runtime.allowUnrestrictedNetwork {
			networkState = "不受限"
		} else if len(runtime.networkDomains) > 0 {
			networkState = strings.Join(runtime.networkDomains, ", ")
		}
	}
	socketCount := 0
	if runtime != nil {
		socketCount = len(runtime.unixSockets)
	}
	reasons := []string{"独立 Pi 进程内加载；声明工具 " + itoa(len(declared)) + " 个"}
	if runtime != nil {
		reasons = append(reasons, "运行时声明：命令 "+commandState+"，网络 "+networkState+"，Unix socket "+itoa(socketCount))
	}
	fact := RuntimeCapabilityLoadFact{
		Id: binding.bound.Id, Version: binding.bound.Version, Kind: capabilityOptionalString(record.Kind),
		Loaded: true, Executable: true,
		Reason: capabilityOptionalString(strings.Join(reasons, "；")),
		Path:   capabilityOptionalString(loadedEntry),
	}
	if source != "" {
		fact.Source = capabilityOptionalString(source)
	}
	if len(declared) > 0 {
		names := []string{}
		for _, tool := range declared {
			names = append(names, tool.Name)
		}
		fact.Tools = names
	}
	if runtime != nil {
		envNames := []string{}
		for name := range runtime.env {
			envNames = append(envNames, name)
		}
		sort.Strings(envNames)
		var networkAccess any
		if runtime.allowUnrestrictedNetwork {
			networkAccess = "unrestricted"
		}
		fact.Runtime = map[string]any{
			"env": envNames, "readPaths": runtime.readPaths, "writePaths": runtime.writePaths,
			"networkDomains": runtime.networkDomains, "networkAccess": networkAccess,
			"allowLocalBinding": runtime.allowLocalBinding, "unixSockets": runtime.unixSockets,
		}
	}
	return []RuntimeCapabilityLoadFact{fact}, nil
}
