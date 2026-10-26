package graph

import (
	"encoding/hex"
	"os"
	"path/filepath"

	"crypto/sha256"
)

// SettleDeliverableInput settles one v2 node's declared file when its execution completes.
type SettleDeliverableInput struct {
	Kernel          *KernelStore
	Artifacts       *ArtifactWorkspace
	GraphId         string
	NodeId          string
	RevisionVersion int
	ExecutionId     string
	Workspace       string
}

// SettleDeliverableOutcome is a kept promise or a failure reason.
type SettleDeliverableOutcome struct {
	Ok          bool
	Published   bool
	ArtifactId  string
	Version     int
	Reason      string
	HasArtifact bool
}

// SettleDeliverable publishes a declared file, or fails the node when the file is missing or empty.
func SettleDeliverable(input SettleDeliverableInput) SettleDeliverableOutcome {
	revision := input.Kernel.Revision(input.GraphId, input.RevisionVersion)
	var deliverable *NodeDeliverable
	if revision != nil {
		if node, ok := revision.Definition.Nodes[input.NodeId]; ok {
			deliverable = node.Deliverable
		}
	}
	if deliverable == nil {
		return SettleDeliverableOutcome{Ok: true, Published: false}
	}
	admitted := kernelRow(input.Kernel.DB, "SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?", input.GraphId, input.NodeId)
	instanceId := input.GraphId + "-" + input.NodeId
	if admitted != nil && kernelString(admitted["instance_id"]) != "" {
		instanceId = kernelString(admitted["instance_id"])
	}
	path := filepath.Clean(filepath.Join(input.Workspace, deliverable.Path))
	if !filepath.IsAbs(path) {
		abs, err := filepath.Abs(path)
		if err != nil {
			panic(err)
		}
		path = abs
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || !info.Mode().IsRegular() {
		return SettleDeliverableOutcome{Ok: false, Reason: deliverable.Path + " was declared as this node's deliverable but was never written"}
	}
	if info.Size() == 0 {
		return SettleDeliverableOutcome{Ok: false, Reason: deliverable.Path + " was declared as this node's deliverable but is empty"}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	logicalKey := deliverable.Namespace + "/" + deliverable.Name
	head := input.Artifacts.Head(input.GraphId, logicalKey)
	headSchema := ""
	if head != nil && head.SchemaKind != nil && *head.SchemaKind != "" {
		version := ""
		if head.SchemaVersion != nil {
			version = itoa(int(*head.SchemaVersion))
		}
		headSchema = *head.SchemaKind + "@" + version
	}
	if head != nil && head.Digest == digest && headSchema == deliverable.Schema {
		return SettleDeliverableOutcome{Ok: true, Published: false, ArtifactId: head.ArtifactId, Version: head.Version, HasArtifact: true}
	}
	publish := PublishArtifactInput{
		TaskId:     input.GraphId,
		Workspace:  input.Workspace,
		Namespace:  deliverable.Namespace,
		Name:       deliverable.Name,
		SourcePath: path,
		Producer: ArtifactProducer{
			NodeId:       input.NodeId,
			InstanceId:   instanceId,
			OperationId:  input.ExecutionId,
			ActivationId: "rev-" + itoa(input.RevisionVersion),
		},
		RequestId: "deliverable-" + input.ExecutionId + "-" + digest[:12],
	}
	if deliverable.Schema != "" {
		publish.Schema = deliverable.Schema
	}
	if deliverable.Title != "" {
		publish.Title = deliverable.Title
	}
	if deliverable.Summary != "" {
		publish.Summary = deliverable.Summary
	}
	record := input.Artifacts.Publish(publish)
	return SettleDeliverableOutcome{Ok: true, Published: true, ArtifactId: record.ArtifactId, Version: record.Version, HasArtifact: true}
}
