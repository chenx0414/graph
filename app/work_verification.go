package main

import (
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

type chatVerificationDraft struct {
	WorkID        string   `json:"workId"`
	WorkRevision  int64    `json:"workRevision"`
	Version       int64    `json:"version"`
	DraftRevision int64    `json:"draftRevision"`
	TargetBranch  string   `json:"targetBranch"`
	Checks        []string `json:"checks"`
	Confirmed     bool     `json:"confirmed"`
}

func (c *chatState) verificationDraftRow(ctx *ui.Context, summary string, draft chatVerificationDraft) {
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Column(ctx).FillWidth().Gap(th.Space(1)).Padding(th.Space(1.5), th.Space(2)).
		Radius(t.Radius.Lg).Border(gwtheme.Hairline, t.Border).Background(t.Card).Children(func() {
		kit.Text(ctx, summary, t.Text.Sm).FontWeight(650).TextColor(t.Foreground)
		for _, check := range draft.Checks {
			kit.Text(ctx, check, t.Text.Sm).TextColor(t.Foreground)
		}
		if draft.Confirmed {
			kit.Text(ctx, "草稿已确认", t.Text.Sm).TextColor(t.SuccessText)
			return
		}
		if draft.TargetBranch == "" {
			kit.Text(ctx, "项目当前没有可确认的目标分支", t.Text.Sm).TextColor(t.Muted)
			return
		}
		kit.Button(ctx, "确认草稿 · "+draft.TargetBranch, kit.ButtonOpts{Variant: kit.Outline, Size: kit.SizeSm}).OnClick(func() {
			go c.confirmVerificationDraft(draft)
		})
	})
}

func (c *chatState) confirmVerificationDraft(draft chatVerificationDraft) {
	key := fmt.Sprintf("verification-%d-%d-%d", draft.WorkRevision, draft.Version, draft.DraftRevision)
	payload, err := c.api.post("/api/orchestration/work/"+url.PathEscape(draft.WorkID)+"/confirm", map[string]any{
		"requestId": draft.WorkID + "-" + key, "graphKey": key, "targetBranch": draft.TargetBranch,
		"workRevision": draft.WorkRevision, "version": draft.Version, "draftRevision": draft.DraftRevision,
	})
	if err != nil {
		onUI(c.window, func() { c.failUser("草稿确认失败：" + err.Error()) })
		return
	}
	var receipt struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(payload, &receipt); err != nil {
		onUI(c.window, func() { c.failUser("读不到草稿确认结果：" + err.Error()) })
		return
	}
	if receipt.State == "blocked" {
		onUI(c.window, func() { c.failUser("草稿已确认，Git 准备受阻：" + receipt.Reason) })
		return
	}
	c.refresh()
}
