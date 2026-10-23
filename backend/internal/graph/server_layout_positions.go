package graph

import (
	"math"
	"sort"
)

func layoutReusePositions(input LayoutInput, positions map[string]LayoutPosition, previous LayoutPrevious) {
	groups := input.Containers
	parents := layoutParentMap(input)
	oldParents := layoutParentMap(previous.Input)
	groupIDs := map[string]bool{}
	for _, group := range groups {
		groupIDs[group.ID] = true
	}
	oldGroups := map[string]bool{}
	for _, group := range previous.Input.Containers {
		oldGroups[group.ID] = true
	}
	stable := map[string]bool{}
	for id := range parents {
		current := id
		unchanged := true
		for {
			_, oldHas := oldParents[current]
			if !oldHas || parents[current] != oldParents[current] || groupIDs[current] != oldGroups[current] {
				unchanged = false
				break
			}
			next, ok := parents[current]
			if !ok || next == "" {
				break
			}
			current = next
		}
		if unchanged {
			if _, ok := previous.Layout.Positions[id]; ok {
				stable[id] = true
			}
		}
	}
	original := map[string]LayoutPosition{}
	for id, box := range positions {
		original[id] = box
	}
	for id := range parents {
		box := positions[id]
		if stable[id] {
			old := previous.Layout.Positions[id]
			if groupIDs[id] {
				positions[id] = old
			} else {
				box.X = old.X
				box.Y = old.Y
				positions[id] = box
			}
		} else {
			ancestor := parents[id]
			for ancestor != "" && !stable[ancestor] {
				ancestor = parents[ancestor]
			}
			if ancestor != "" {
				box.X += previous.Layout.Positions[ancestor].X - original[ancestor].X
				box.Y += previous.Layout.Positions[ancestor].Y - original[ancestor].Y
				positions[id] = box
			}
		}
	}
	children := func(parent string) []string {
		out := []string{}
		for id, value := range parents {
			if value == parent {
				out = append(out, id)
			}
		}
		return out
	}
	var shift func(string, float64, float64)
	shift = func(id string, dx, dy float64) {
		stack := []string{id}
		for len(stack) > 0 {
			next := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			box := positions[next]
			box.X += dx
			box.Y += dy
			positions[next] = box
			stack = append(stack, children(next)...)
		}
	}
	incoming := map[string]int{}
	outgoing := map[string]int{}
	for _, edge := range input.Edges {
		incoming[edge.Target]++
		outgoing[edge.Source]++
	}
	type footprint struct {
		id     string
		x, y   float64
		width  float64
		height float64
		top    float64
	}
	footprintOf := func(id string) footprint {
		box := positions[id]
		top := 0.0
		bottom := 0.0
		if !groupIDs[id] && incoming[id] > 0 {
			top = layoutGRID * float64(incoming[id]+1)
		}
		if !groupIDs[id] && outgoing[id] > 0 {
			bottom = layoutGRID * float64(outgoing[id]+1)
		}
		return footprint{id: id, x: box.X, y: box.Y - top, width: box.Width, height: box.Height + top + bottom, top: top}
	}
	unchanged := func(id string) bool {
		box, ok := positions[id]
		old, oldOK := previous.Layout.Positions[id]
		return stable[id] && ok && oldOK && box.X == old.X && box.Y == old.Y && box.Width == old.Width && box.Height == old.Height
	}
	settle := func(parent string) {
		occupied := []footprint{}
		ids := children(parent)
		sort.Slice(ids, func(i, j int) bool {
			priority := func(id string) int {
				value := 0
				if !stable[id] {
					value += 2
				}
				if !groupIDs[id] {
					value++
				}
				return value
			}
			return priority(ids[i]) < priority(ids[j])
		})
		for _, id := range ids {
			box := positions[id]
			before := box
			if parent != "" && !stable[id] {
				box.X = math.Max(box.X, positions[parent].X+32)
				box.Y = math.Max(box.Y, positions[parent].Y+32)
				positions[id] = box
			}
			for {
				area := footprintOf(id)
				collisions := []footprint{}
				for _, other := range occupied {
					if unchanged(id) && unchanged(other.id) {
						continue
					}
					if area.x < other.x+other.width+32 && area.x+area.width+32 > other.x && area.y < other.y+other.height+32 && area.y+area.height+32 > other.y {
						collisions = append(collisions, other)
					}
				}
				if len(collisions) == 0 {
					break
				}
				next := collisions[0].y + collisions[0].height + 32 + area.top
				for _, other := range collisions[1:] {
					if candidate := other.y + other.height + 32 + area.top; candidate > next {
						next = candidate
					}
				}
				box = positions[id]
				box.Y = layoutSnap(next)
				positions[id] = box
			}
			box = positions[id]
			dx := box.X - before.X
			dy := box.Y - before.Y
			box.X = before.X
			box.Y = before.Y
			positions[id] = box
			shift(id, dx, dy)
			occupied = append(occupied, footprintOf(id))
		}
		if parent != "" {
			box := positions[parent]
			width, height := box.Width, box.Height
			for _, id := range children(parent) {
				if unchanged(id) {
					continue
				}
				child := positions[id]
				if child.X+child.Width-box.X+32 > width {
					width = child.X + child.Width - box.X + 32
				}
				if child.Y+child.Height-box.Y+32 > height {
					height = child.Y + child.Height - box.Y + 32
				}
			}
			box.Width = math.Ceil(width/32) * 32
			box.Height = math.Ceil(height/layoutGRID) * layoutGRID
			positions[parent] = box
		}
	}
	depth := func(id string) int {
		count := 0
		current := parents[id]
		for current != "" {
			count++
			current = parents[current]
		}
		return count
	}
	ordered := append([]LayoutGroup{}, groups...)
	sort.Slice(ordered, func(i, j int) bool { return depth(ordered[i].ID) > depth(ordered[j].ID) })
	for _, group := range ordered {
		settle(group.ID)
	}
	settle("")
	boxes := []LayoutPosition{}
	for id := range parents {
		boxes = append(boxes, positions[id])
	}
	width, height := 160.0, 64.0
	for _, box := range boxes {
		if box.X+box.Width+32 > width {
			width = box.X + box.Width + 32
		}
		if box.Y+box.Height+32 > height {
			height = box.Y + box.Height + 32
		}
	}
	positions["root"] = LayoutPosition{X: 0, Y: 0, Width: math.Ceil(width/32) * 32, Height: math.Ceil(height/layoutGRID) * layoutGRID}
}
