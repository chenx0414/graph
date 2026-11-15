package graph

func layoutFallback(graph map[string]any) map[string]any {
	if graph == nil {
		return nil
	}
	return layoutFallbackGroup(graph)
}

func layoutFallbackGroup(group map[string]any) map[string]any {
	children, isGroup := group["children"].([]any)
	if !isGroup {
		group["x"] = 0
		group["y"] = 0
		return group
	}
	const padding = 24.0
	const gap = 96.0
	cursor := padding
	width := 160.0
	for _, raw := range children {
		child, _ := raw.(map[string]any)
		if child == nil {
			continue
		}
		laid := layoutFallbackGroup(child)
		childWidth := layoutNumberDefault(laid["width"], 160)
		childHeight := layoutNumberDefault(laid["height"], 64)
		laid["x"] = padding
		laid["y"] = cursor
		cursor += childHeight + gap
		if childWidth+padding*2 > width {
			width = childWidth + padding*2
		}
	}
	group["x"] = 0
	group["y"] = 0
	group["width"] = width
	group["height"] = cursor + padding
	return group
}
