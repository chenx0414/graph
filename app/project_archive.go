package main

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func (s *shellState) archiveProject(projectID string) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return
	}
	go func() {
		body := map[string]any{"requestId": requestID("archive")}
		if _, err := s.api.post("/api/projects/"+url.PathEscape(projectID)+"/archive", body); err != nil {
			onUI(s.window, func() {
				s.status = "归档失败：" + err.Error()
				s.frame()
			})
			return
		}
		onUI(s.window, func() {
			s.dropArchivedProject(projectID)
			s.frame()
		})
	}()
}

func (s *shellState) dropArchivedProject(projectID string) {
	kept := make([]conversationSummary, 0, len(s.conversations))
	for _, conversation := range s.conversations {
		if conversation.ProjectID != projectID {
			kept = append(kept, conversation)
		}
	}
	s.conversations = kept
	if s.activeID != "" && s.activeID == s.supervisorID {
		return
	}
	for _, conversation := range s.conversations {
		if conversation.ID == s.activeID {
			return
		}
	}
	if s.supervisorID != "" {
		s.selectConversation(s.supervisorID)
		return
	}
	if len(s.conversations) > 0 {
		s.selectConversation(s.conversations[0].ID)
		return
	}
	s.chatMu.Lock()
	s.chat = nil
	s.activeID = ""
	s.chatMu.Unlock()
	s.resetConversationBoardData()
}

type archiveConfirmState struct {
	projectID string
	label     string
	active    int
	open      bool
}

func (s *shellState) requestArchive(projectID, label string) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return
	}
	label = strings.TrimSpace(label)
	go func() {
		payload, err := s.api.get("/api/projects/" + url.PathEscape(projectID) + "/lifecycle")
		if err != nil {
			onUI(s.window, func() {
				s.status = "归档失败：" + err.Error()
				s.frame()
			})
			return
		}
		var lifecycle struct {
			Archived         bool `json:"archived"`
			ActiveExecutions int  `json:"activeExecutions"`
		}
		if json.Unmarshal(payload, &lifecycle) != nil {
			onUI(s.window, func() {
				s.status = "归档失败：项目状态不是预期的 JSON"
				s.frame()
			})
			return
		}
		if lifecycle.Archived {
			return
		}
		if lifecycle.ActiveExecutions > 0 {
			onUI(s.window, func() {
				s.archiveConfirm = &archiveConfirmState{projectID: projectID, label: label, active: lifecycle.ActiveExecutions, open: true}
				s.frame()
			})
			return
		}
		s.archiveProject(projectID)
	}()
}

func (s *shellState) archiveConfirmView(ctx *ui.Context) {
	state := s.archiveConfirm
	if state == nil {
		return
	}
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Modal(ctx, &state.open, func() {
		card := ui.Column(ctx).Width(gwtheme.DialogSmWidth).Gap(th.Space(2)).Padding(th.Space(4)).
			Radius(t.Radius.Xl).Background(t.Background).Border(gwtheme.Hairline, t.Border).Label("归档确认")
		kit.Elevate(ctx, card, gwtheme.ShadowXl)
		card.Children(func() {
			kit.Text(ctx, "归档项目？", t.Text.Lg).FontWeight(600)
			kit.Text(ctx, "「"+state.label+"」现在有 "+strconv.Itoa(state.active)+" 个正在运行的任务。归档会停止这些工作，并从会话列表移除该项目。", t.Text.Sm).TextColor(t.Muted)
			ui.Row(ctx).FillWidth().Justify(ui.End).Gap(th.Space(1)).Children(func() {
				if kit.Button(ctx, "取消", kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).Clicked() {
					state.open = false
				}
				if kit.Button(ctx, "归档", kit.ButtonOpts{Variant: kit.DestructiveOutline, Size: kit.SizeSm}).Clicked() {
					state.open = false
					s.archiveProject(state.projectID)
				}
			})
		})
	})
	if !state.open {
		s.archiveConfirm = nil
		s.frame()
	}
}
