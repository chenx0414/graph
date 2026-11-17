package mygoauto

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

type protocolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *protocolError) Error() string { return "mygoauto: " + e.Code + ": " + e.Message }

type client struct {
	path string
	conn net.Conn
	read *bufio.Reader
	mu   sync.Mutex
	id   int
}

func dial(path string, timeout time.Duration) (*client, error) {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return nil, fmt.Errorf("mygoauto: cannot reach the app at %s: %w", path, err)
	}
	return &client{path: path, conn: conn, read: bufio.NewReader(conn)}, nil
}

func (c *client) close() error { return c.conn.Close() }

func (c *client) call(method string, params any, out any, timeout time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.id++
	request := map[string]any{"id": c.id, "method": method}
	if params != nil {
		request["params"] = params
	}
	line, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if err := c.conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	if _, err := c.conn.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("mygoauto: %s: write: %w", method, err)
	}
	answer, err := c.read.ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("mygoauto: %s: read: %w", method, err)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *protocolError  `json:"error"`
	}
	if err := json.Unmarshal(answer, &envelope); err != nil {
		return fmt.Errorf("mygoauto: %s: answer is not JSON: %w", method, err)
	}
	if envelope.Error != nil {
		return envelope.Error
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}

type Window struct {
	ID            int    `json:"id"`
	Title         string `json:"title"`
	Kind          string `json:"kind"`
	URL           string `json:"url"`
	Focused       bool   `json:"focused"`
	Visible       bool   `json:"visible"`
	Bounds        Rect   `json:"bounds"`
	ContentBounds Rect   `json:"contentBounds"`
}

type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (r Rect) screenCaptureArgs() []string {
	return []string{fmt.Sprintf("-R%0.f,%0.f,%0.f,%0.f", r.X, r.Y, r.Width, r.Height)}
}

func (c *client) windows(timeout time.Duration) ([]Window, error) {
	var result struct {
		Windows []Window `json:"windows"`
	}
	if err := c.call("windows", nil, &result, timeout); err != nil {
		return nil, err
	}
	return result.Windows, nil
}

func (c *client) tree(window int, timeout time.Duration) ([]Node, error) {
	var result struct {
		Window int    `json:"window"`
		Nodes  []Node `json:"nodes"`
	}
	if err := c.call("tree", map[string]any{"window": window}, &result, timeout); err != nil {
		return nil, err
	}
	return result.Nodes, nil
}

func (c *client) act(window int, id string, action, text string, timeout time.Duration) error {
	params := map[string]any{"window": window, "id": id, "action": action}
	if text != "" {
		params["text"] = text
	}
	return c.call("act", params, nil, timeout)
}

func (c *client) idle(window int, timeout time.Duration) error {
	return c.call("idle", map[string]any{"window": window, "timeout": timeout.Milliseconds()}, nil, timeout+5*time.Second)
}

func socketExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode()&os.ModeSocket != 0
}

var errNoWindow = errors.New("mygoauto: no native window")
