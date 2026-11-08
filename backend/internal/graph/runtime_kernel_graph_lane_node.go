package graph

import (
	"os"
	"path/filepath"
	"strings"
)

func (state *kernelGraphLaneState) nodeDefinition(graphId, nodeId string, revisionVersion *int) *NodeDefinition {
	active := state.options.Kernel.RunningExecution(graphId, nodeId)
	revision := revisionVersion
	if revision == nil && active != nil {
		value := active.RevisionVersion
		revision = &value
	}
	var definition *GraphDefinition
	if revision == nil {
		if latest := state.options.Kernel.LatestRevision(graphId); latest != nil {
			definition = &latest.Definition
		}
	} else if row := state.options.Kernel.Revision(graphId, *revision); row != nil {
		definition = &row.Definition
	}
	if definition == nil {
		return nil
	}
	node, ok := definition.Nodes[nodeId]
	if !ok {
		return nil
	}
	return &node
}

func (state *kernelGraphLaneState) nodeLocation(graphId, nodeId string, revisionVersion *int, prepare bool) (location *kernelGraphLaneNodeLocation) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if failure, ok := recovered.(*RuntimeError); ok {
			panic(failure)
		}
		Raise("invalid_workspace", "Node workspace cannot be opened: "+rsiPanicMessage(recovered))
	}()
	if frozen := state.restoring.Get(graphId + "/" + nodeId); frozen != nil {
		configuration := frozen.Record.Configuration
		return &kernelGraphLaneNodeLocation{Workspace: frozen.Record.Policy.Workspace, Base: mapString(asMap(configuration.ExecutionConfiguration), "base")}
	}
	node := state.nodeDefinition(graphId, nodeId, revisionVersion)
	selected := "auto"
	if node != nil && node.Workspace != nil {
		selected = node.Workspace.Base
	}
	instanceID, admitted := state.options.Kernel.NodeInstanceID(graphId, nodeId)
	key := graphId + "/" + nodeId
	execution := state.options.Kernel.RunningExecution(graphId, nodeId)
	reseed := false
	if prepare && execution != nil && node != nil && node.Recipe != "" &&
		state.options.Catalog.HasDefinition(node.Recipe) && state.options.Catalog.Definition(node.Recipe).Review &&
		state.preparedReviewExecutions.Get(key) != execution.Id {
		reseed = len(state.options.Kernel.ProviderCallsOfExecution(execution.Id)) == 0
	}
	var copy *string
	if selected != "project" && state.options.Git != nil && admitted {
		action := "work"
		if reseed {
			action = "review"
		}
		copy = state.options.Git.Workspace(graphId, &instanceID, nodeId, "agent", action)
	}
	if copy != nil && reseed {
		state.preparedReviewExecutions.Store(key, execution.Id)
	}
	if selected == "worktree" && copy == nil {
		Raise("invalid_workspace", "Node requests a worktree; prepare this graph with a targetBranch first")
	}
	base := copy
	if base == nil {
		base = state.options.WorkspaceFor(graphId)
	}
	if base == nil {
		return nil
	}
	root, err := filepath.EvalSymlinks(*base)
	if err != nil {
		panic(err)
	}
	relative := "."
	if node != nil && node.Workspace != nil && node.Workspace.Path != "" {
		relative = node.Workspace.Path
	}
	workspace, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		panic(err)
	}
	within, err := filepath.Rel(root, workspace)
	if err != nil {
		panic(err)
	}
	if within == ".." || strings.HasPrefix(within, "../") || strings.HasPrefix(within, "/") {
		Raise("permission", "Node workspace path escapes its declared base")
	}
	info, err := os.Stat(workspace)
	if err != nil {
		panic(err)
	}
	if !info.IsDir() {
		Raise("invalid_workspace", "Node workspace path must be an existing directory")
	}
	kind := "project"
	if copy != nil {
		kind = "worktree"
	}
	return &kernelGraphLaneNodeLocation{Workspace: workspace, Base: kind}
}

func (state *kernelGraphLaneState) nodeWorkspace(graphId, nodeId string, revisionVersion *int) *string {
	location := state.nodeLocation(graphId, nodeId, revisionVersion, false)
	if location == nil {
		return nil
	}
	workspace := location.Workspace
	return &workspace
}



type kernelGraphLaneNodeChannel struct {
	inner   ModelEventStream
	usage   TokenUsage
	unknown bool
	refusal *RuntimeError
	release func()
	done    bool
}

func (channel *kernelGraphLaneNodeChannel) Next() (map[string]any, bool) {
	event, ok := channel.inner.Next()
	if !ok {
		channel.finish()
	}
	return event, ok
}

func (channel *kernelGraphLaneNodeChannel) Result() map[string]any {
	settlement := channel.inner.Result()
	channel.finish()
	return settlement
}

func (channel *kernelGraphLaneNodeChannel) settlement() map[string]any {
	settlement := channel.Result()
	if channel.refusal != nil && settlement["stopReason"] == "error" {
		settlement["errorMessage"] = channel.refusal.Message
	}
	return settlement
}

func (channel *kernelGraphLaneNodeChannel) finish() {
	if channel.done {
		return
	}
	channel.done = true
	if channel.release != nil {
		channel.release()
	}
}
