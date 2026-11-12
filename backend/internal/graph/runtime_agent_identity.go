package graph

import "github.com/chenx0414/graph/backend/internal/agentcore"

func agentIdentityOfOperation(operation Operation, conversation *ConversationRow) agentcore.Identity {
	identity := agentcore.Identity{ID: operation.TaskId, Kind: agentcore.Node, Role: "master", Name: operation.NodeId}
	if conversation == nil {
		return identity
	}
	identity.ID = conversation.Id
	identity.Name = conversation.Title
	switch conversation.Role {
	case ConversationGlobal:
		identity.Kind = agentcore.Global
		identity.Role = "global"
	case ConversationProject:
		identity.Kind = agentcore.Project
		identity.Role = "project"
	}
	return identity
}

func agentIdentityOfNode(taskId, nodeId, role, parentId string) agentcore.Identity {
	if role == "" {
		role = "worker"
	}
	return agentcore.Identity{
		ID:       taskId + "/" + nodeId,
		ParentID: parentId,
		Kind:     agentcore.Node,
		Role:     role,
		Name:     nodeId,
	}
}
