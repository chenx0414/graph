package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func fleetAgentForScope(data *fleetSnapshot, scope chatScope) *fleetAgent {
	if data == nil {
		return nil
	}
	switch scope.Kind {
	case "node":
		for index := range data.Agents {
			agent := data.Agents[index]
			if agent.TaskID == scope.TaskID && agent.NodeID == scope.NodeID {
				return &data.Agents[index]
			}
		}
	case "conversation":
		for index := range data.Agents {
			agent := data.Agents[index]
			if agent.ConversationID != scope.ConversationID {
				continue
			}
			if agent.Kind == "global" || agent.Kind == "project" || agent.Kind == "child" {
				return &data.Agents[index]
			}
		}
		for index := range data.Agents {
			if data.Agents[index].ID == scope.ConversationID {
				return &data.Agents[index]
			}
		}
	}
	return nil
}

func (s *shellState) chatAgent() (*fleetAgent, *fleetSnapshot) {
	scope := s.chatScope()
	if scope.key() == "" {
		return nil, nil
	}
	if agent := fleetAgentForScope(s.fleet.data, scope); agent != nil {
		return agent, s.fleet.data
	}
	if s.fleet.global == nil && !s.fleet.globalLoading && s.fleet.globalFailed == "" {
		s.ensureGlobalFleet()
	}
	if agent := fleetAgentForScope(s.fleet.global, scope); agent != nil {
		return agent, s.fleet.global
	}
	return nil, nil
}

func (s *shellState) agentPanelTask(ctx *ui.Context, scope chatScope) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	chat := s.active()
	if scope.Kind != "node" || chat == nil || len(chat.tasks) == 0 {
		return
	}
	section := ui.Column(ctx).FillWidth().Gap(th.Space(0.75)).Padding(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Stroke, t.Border)
	section.Children(func() {
		kit.Text(ctx, "所属任务", t.Text.Sm).FontWeight(600).TextColor(t.Foreground)
		for _, task := range chat.tasks {
			kit.Text(ctx, taskLabel(task), t.Text.Sm).TextColor(t.Foreground).SingleLine().Ellipsis("…")
			for _, node := range task.nodes {
				ui.Row(ctx).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
					kit.Text(ctx, nodeLabel(node), t.Text.Xs).TextColor(t.Muted).Grow(1).SingleLine().Ellipsis("…")
					s.definitionLink(ctx, t, node.definition)
				})
			}
		}
	})
}

func (s *shellState) panelChatAgent(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	if chat := s.active(); chat != nil && chat.loading {
		skeletonCard(ctx, 4, false, true)
		return
	}
	scope := s.chatScope()
	if scope.key() == "" {
		s.boardNote(ctx, "先打开一个对话，这里会显示它对应的 Agent。")
		return
	}
	agent, data := s.chatAgent()
	if agent == nil {
		if s.fleet.data == nil && s.fleet.global == nil {
			if s.fleet.failed != "" {
				kit.Text(ctx, s.fleet.failed, t.Text.Sm).TextColor(t.Muted)
				return
			}
			s.ensureFleet()
			skeletonCard(ctx, 4, false, true)
			return
		}
		s.boardNote(ctx, "这个对话还没有登记为 Agent。")
		return
	}
	s.ensureFleetDetail(*agent)
	accent := fleetAccent(*agent, fleetGroupIndex(data, *agent))
	s.agentDetailHeader(ctx, *agent, data, accent, false)
	s.agentDetailStats(ctx, *agent)
	s.agentPanelTask(ctx, scope)
	s.agentDetailActivity(ctx, *agent)
	s.agentDetailRelations(ctx, data, *agent)
}
