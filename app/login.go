package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

const loginPollAttempts = 120

type providerLogin struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerId"`
	State      string `json:"state"`
	URL        string `json:"url"`
	UserCode   string `json:"userCode"`
	Message    string `json:"message"`
}

func (l providerLogin) done() bool {
	switch l.State {
	case "complete", "cancelled", "failed", "expired":
		return true
	}
	return false
}

func loginLabel(login providerLogin) string {
	switch {
	case login.State == "complete":
		return "已登录完成"
	case login.State == "cancelled":
		return "已取消登录"
	case login.State == "failed":
		return "登录失败：" + login.Message
	case login.State == "expired":
		return "登录码已过期，重试一次"
	case login.UserCode != "":
		return "在浏览器输入设备码 " + login.UserCode + "（" + login.State + "）"
	}
	return "等待授权（" + login.State + "）"
}

func (s *settingsState) startLogin(row credentialRow) {
	body, _ := json.Marshal(map[string]string{"providerId": row.id, "credentialRef": row.secretRef})
	payload, err := s.postLogin("/api/providers/login", body)
	if err != nil {
		s.status = "开始登录失败：" + err.Error()
		s.frame()
		return
	}
	s.login = payload
	s.status = "登录已开始"
	s.frame()
	go s.pollLogin()
}

func (s *settingsState) pollLogin() {
	for attempt := 0; attempt < loginPollAttempts; attempt++ {
		time.Sleep(time.Second)
		if s.login.done() || s.login.ID == "" {
			return
		}
		next, err := s.refreshLogin()
		if err != nil {
			s.status = "登录状态读取失败：" + err.Error()
			s.frame()
			return
		}
		s.login = next
		s.frame()
		if next.State == "complete" {
			s.status = s.login.ProviderID + " 已登录"
			s.frame()
			s.load()
			return
		}
	}
}

func (s *settingsState) refreshLogin() (providerLogin, error) {
	var login providerLogin
	payload, err := daemonGet(s.address, s.token, "/api/providers/login/"+s.login.ID)
	if err != nil {
		return login, err
	}
	if err := json.Unmarshal(payload, &login); err != nil {
		return login, err
	}
	return login, nil
}

func (s *settingsState) cancelLogin() {
	if s.login.ID == "" {
		return
	}
	payload, err := s.postLogin("/api/providers/login/"+s.login.ID+"/cancel", nil)
	if err != nil {
		s.status = "取消登录失败：" + err.Error()
		s.frame()
		return
	}
	s.login = payload
	s.status = "已取消登录"
	s.frame()
}

func (s *settingsState) openLoginURL() {
	if s.login.URL == "" || s.openURL == nil {
		s.status = "这次登录没有可打开的链接"
		s.frame()
		return
	}
	if err := s.openURL(s.login.URL); err != nil {
		s.status = "打不开链接：" + err.Error()
		s.frame()
		return
	}
	s.frame()
}

func (s *settingsState) postLogin(path string, body []byte) (providerLogin, error) {
	var login providerLogin
	if body == nil {
		body = []byte("{}")
	}
	request, err := daemonPostRequest(s.address, s.token, path, body)
	if err != nil {
		return login, err
	}
	if token := strings.TrimSpace(s.token); token != "" {
		request.Header.Set("Cookie", "graph_session="+token)
	}
	request.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return login, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return login, errStatus(response.Status)
	}
	if err := json.NewDecoder(response.Body).Decode(&login); err != nil {
		return login, err
	}
	return login, nil
}

func (s *settingsState) loginSection(ctx *ui.Context) {
	t := ctx.Theme()
	if s.login.ID == "" {
		return
	}
	ui.Column(ctx).Gap(4).Children(func() {
		ui.Text(ctx, loginLabel(s.login)).FontSize(12).TextColor(t.TextMuted)
		ui.Row(ctx).Gap(8).Children(func() {
			if s.login.URL != "" && ui.Button(ctx, "打开授权链接").Clicked() {
				go s.openLoginURL()
			}
			if !s.login.done() && ui.Button(ctx, "取消登录").Clicked() {
				go s.cancelLogin()
			}
		})
	})
}
