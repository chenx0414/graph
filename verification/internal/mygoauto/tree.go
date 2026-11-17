package mygoauto

import (
	"errors"
	"fmt"
	"strings"
)

type Node struct {
	ID          string   `json:"id"`
	Parent      string   `json:"parent"`
	Role        string   `json:"role"`
	Label       string   `json:"label"`
	Value       string   `json:"value"`
	Placeholder string   `json:"placeholder"`
	Key         any      `json:"key"`
	States      []string `json:"states"`
	Actions     []string `json:"actions"`
	Bounds      Rect     `json:"bounds"`
	Level       int      `json:"level"`
}

func (n Node) Name() string {
	if n.Label != "" {
		return n.Label
	}
	return n.Placeholder
}

func (n Node) hasState(state string) bool {
	for _, value := range n.States {
		if value == state {
			return true
		}
	}
	return false
}

type Tree []Node

func (t Tree) byID(id string) (Node, bool) {
	for _, node := range t {
		if node.ID == id {
			return node, true
		}
	}
	return Node{}, false
}

func (t Tree) ancestry(node Node) []Node {
	chain := []Node{node}
	for {
		parent, ok := t.byID(node.Parent)
		if !ok || parent.ID == node.ID {
			return chain
		}
		chain = append(chain, parent)
		node = parent
	}
}

func (t Tree) Under(node Node, label string) bool {
	for _, ancestor := range t.ancestry(node) {
		if ancestor.Label == label {
			return true
		}
	}
	return false
}

type Sel struct {
	Role  string
	Label string
	Under string
	Nth   int
	Value string
}

var errNoMatch = errors.New("mygoauto: no element matches the selector")

func (t Tree) Find(sel Sel) (Node, error) {
	matches := t.Match(sel)
	if len(matches) <= sel.Nth {
		return Node{}, fmt.Errorf("%w: role=%q label=%q under=%q nth=%d, tree has %d match(es); run the tree command and read the labels",
			errNoMatch, sel.Role, sel.Label, sel.Under, sel.Nth, len(matches))
	}
	return matches[sel.Nth], nil
}

func (t Tree) Match(sel Sel) []Node {
	matches := []Node{}
	for _, node := range t {
		if sel.Role != "" && node.Role != sel.Role {
			continue
		}
		if sel.Label != "" && node.Label != sel.Label {
			continue
		}
		if sel.Value != "" && node.Value != sel.Value {
			continue
		}
		if sel.Under != "" && !t.Under(node, sel.Under) {
			continue
		}
		matches = append(matches, node)
	}
	return matches
}

func (t Tree) Labels() []string {
	labels := make([]string, 0, len(t))
	for _, node := range t {
		if node.Label != "" {
			labels = append(labels, node.Role+" "+node.Label)
		}
	}
	return labels
}

func (t Tree) Contain(labelSubstring string) []Node {
	matches := []Node{}
	for _, node := range t {
		if strings.Contains(node.Label, labelSubstring) {
			matches = append(matches, node)
		}
	}
	return matches
}

func Diff(before, after Tree) (added, removed []Node) {
	beforeIDs := map[string]bool{}
	for _, node := range before {
		beforeIDs[node.ID] = true
	}
	afterIDs := map[string]bool{}
	for _, node := range after {
		afterIDs[node.ID] = true
		if !beforeIDs[node.ID] {
			added = append(added, node)
		}
	}
	for _, node := range before {
		if !afterIDs[node.ID] {
			removed = append(removed, node)
		}
	}
	return added, removed
}
