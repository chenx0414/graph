package main

func normalizeBoardLayout(node *boardNode) {
	if node.Kind != "split" {
		return
	}
	for index := range node.Children {
		normalizeBoardLayout(&node.Children[index].Node)
	}
	kept := make([]boardSlot, 0, len(node.Children))
	for _, slot := range node.Children {
		child := slot.Node
		if child.Kind == "split" {
			switch {
			case len(child.Children) == 0:
				continue
			case len(child.Children) == 1:
				inner := child.Children[0]
				slot.Node = inner.Node
				slot.Weight *= inner.Weight
				kept = append(kept, slot)
				continue
			case child.Axis == node.Axis:
				for _, inner := range child.Children {
					inner.Weight *= slot.Weight
					kept = append(kept, inner)
				}
				continue
			}
		}
		kept = append(kept, slot)
	}
	node.Children = kept
	if len(node.Children) == 1 {
		*node = node.Children[0].Node
	}
	if node.Kind == "split" {
		for index := range node.Children {
			if node.Children[index].Weight <= 0 {
				node.Children[index].Weight = 1
			}
		}
	}
}

func removeBoardPanelFromLayout(node *boardNode, panelID string) {
	if node.Kind != "split" {
		return
	}
	kept := make([]boardSlot, 0, len(node.Children))
	for _, slot := range node.Children {
		if slot.Node.Kind == "panel" && slot.Node.PanelID == panelID {
			continue
		}
		removeBoardPanelFromLayout(&slot.Node, panelID)
		kept = append(kept, slot)
	}
	node.Children = kept
}

func findBoardLeaf(node *boardNode, panelID string) *boardNode {
	if node.Kind == "panel" {
		if node.PanelID == panelID {
			return node
		}
		return nil
	}
	for index := range node.Children {
		if found := findBoardLeaf(&node.Children[index].Node, panelID); found != nil {
			return found
		}
	}
	return nil
}

func findBoardSplit(node *boardNode, axis string, panelID string) *boardNode {
	if node.Kind != "split" {
		return nil
	}
	for index := range node.Children {
		if node.Children[index].Node.Kind == "panel" && node.Children[index].Node.PanelID == panelID && node.Axis == axis {
			return node
		}
	}
	for index := range node.Children {
		if found := findBoardSplit(&node.Children[index].Node, axis, panelID); found != nil {
			return found
		}
	}
	return nil
}

func splitBoardPane(root *boardNode, targetID, sourceID, edge string) bool {
	removeBoardPanelFromLayout(root, sourceID)
	normalizeBoardLayout(root)
	target := findBoardLeaf(root, targetID)
	if target == nil {
		return false
	}
	axis := "row"
	before := edge == "left" || edge == "top"
	if edge == "top" || edge == "bottom" {
		axis = "column"
	}
	source := boardNode{Kind: "panel", PanelID: sourceID}
	existing := *target
	children := []boardSlot{{Weight: 1, Node: existing}, {Weight: 1, Node: source}}
	if before {
		children[0], children[1] = children[1], children[0]
	}
	*target = boardNode{Kind: "split", Axis: axis, Children: children}
	normalizeBoardLayout(root)
	return true
}

func swapBoardPanels(root *boardNode, first, second string) {
	firstLeaf := findBoardLeaf(root, first)
	secondLeaf := findBoardLeaf(root, second)
	if firstLeaf == nil || secondLeaf == nil {
		return
	}
	firstLeaf.PanelID, secondLeaf.PanelID = secondLeaf.PanelID, firstLeaf.PanelID
}
