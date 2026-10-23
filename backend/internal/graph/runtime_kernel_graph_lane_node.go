package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// The node lookups: what a node is, where it works and what it may do.
//
// They read the lane's state, so they are methods on it.

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

// Use the execution's frozen location, including publication during a concurrent patch.
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
	if frozen := state.restoring[graphId+"/"+nodeId]; frozen != nil {
		configuration := frozen.Record.Configuration
		return &kernelGraphLaneNodeLocation{Workspace: frozen.Record.Policy.Workspace, Base: mapString(asMap(configuration.ExecutionConfiguration), "base")}
	}
	node := state.nodeDefinition(graphId, nodeId, revisionVersion)
	selected := "auto"
	if node != nil && node.Workspace != nil {
		selected = node.Workspace.Base
	}
	admitted := kernelRow(state.options.Kernel.Db, "SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?", graphId, nodeId)
	key := graphId + "/" + nodeId
	execution := state.options.Kernel.RunningExecution(graphId, nodeId)
	// Prepare each new review against the current integration. Retries, recovery
	// after a provider call, and settlement retain the tree already observed.
	reseed := false
	if prepare && execution != nil && node != nil && node.Recipe != "" &&
		state.options.Catalog.HasDefinition(node.Recipe) && state.options.Catalog.Definition(node.Recipe).Review &&
		state.preparedReviewExecutions[key] != execution.Id {
		reseed = kernelRow(state.options.Kernel.Db, "SELECT 1 FROM kernel_provider_calls WHERE execution_id=? LIMIT 1", execution.Id) == nil
	}
	var copy *string
	if selected != "project" && state.options.Git != nil && admitted != nil {
		instanceID := graphDBString(admitted, "instance_id")
		action := "work"
		if reseed {
			action = "review"
		}
		copy = state.options.Git.Workspace(graphId, &instanceID, nodeId, "agent", action)
	}
	if copy != nil && reseed {
		state.preparedReviewExecutions[key] = execution.Id
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

func (state *kernelGraphLaneState) nodeAccess(graphId, nodeId string, revisionVersion int) *ResolvedAccessPolicy {
	if frozen := state.restoring[graphId+"/"+nodeId]; frozen != nil {
		body, _ := json.Marshal(asMap(frozen.Record.Configuration.ExecutionConfiguration)["access"])
		var access ResolvedAccessPolicy
		if err := json.Unmarshal(body, &access); err != nil {
			panic(err)
		}
		return &access
	}
	var requested any
	if node := state.nodeDefinition(graphId, nodeId, &revisionVersion); node != nil && node.Access != nil {
		requested = node.Access
	}
	context := AccessPolicyContext{StateDir: state.options.StateDir, GraphHome: state.options.GraphHome}
	ceiling := ResolveAccessPolicy(StandardAccessPolicy(), context)
	// The TypeScript read is `state.options.access?.() ?? resolveAccessPolicy(...)`, so a host
	// that has no ceiling to give falls back to the standard policy.
	if state.options.Access != nil {
		if resolved := state.options.Access(); resolved != nil {
			ceiling = resolved
		}
	}
	return NodeAccessPolicy(requested, ceiling, context)
}

// kernelGraphLaneNodeChannel is one node's provider channel.
//
// It is the stream the kernel reads, with the cleanup the turn owes attached:
// the store listener and the host's abort listener are released when the
// answer is over. The refusal is the gate's own reason: a paused or
// over-budget send is refused with the host's reason, so the answer carries
// it instead of a bare transport error.
type kernelGraphLaneNodeChannel struct {
	inner   ModelEventStream
	usage   TokenUsage
	unknown bool
	refusal *RuntimeError
	release func()
	done    bool
}

// Next returns the next event of the answer.
func (channel *kernelGraphLaneNodeChannel) Next() (map[string]any, bool) {
	event, ok := channel.inner.Next()
	if !ok {
		channel.finish()
	}
	return event, ok
}

// Result returns the settlement of the answer.
func (channel *kernelGraphLaneNodeChannel) Result() map[string]any {
	settlement := channel.inner.Result()
	channel.finish()
	return settlement
}

// settlement is the answer the caller reports.
func (channel *kernelGraphLaneNodeChannel) settlement() map[string]any {
	settlement := channel.Result()
	// Provider SDKs wrap gate refusals as connection errors. Preserve the
	// host's control reason so pause cannot consume automatic retries.
	if channel.refusal != nil && settlement["stopReason"] == "error" {
		settlement["errorMessage"] = channel.refusal.Message
	}
	return settlement
}

// finish releases the turn's listeners once the answer is over.
func (channel *kernelGraphLaneNodeChannel) finish() {
	if channel.done {
		return
	}
	channel.done = true
	if channel.release != nil {
		channel.release()
	}
}
