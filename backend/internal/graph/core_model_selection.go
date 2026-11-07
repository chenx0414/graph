package graph

type PickModelInput struct {
	Spec   NodeSpec
	Models func() []ModelEntry
}

func PickModel(input PickModelInput) *ModelEntry {
	requested := ""
	if input.Spec.Model != nil {
		requested = *input.Spec.Model
	}
	return SelectModel(SelectModelInput{
		Requested: requested,
		Directory: input.Models(),
	})
}
