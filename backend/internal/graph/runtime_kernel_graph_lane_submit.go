package graph

// kernelGraphLaneSubmitSchema is the argument schema of the node's submit tool.
//
// The key order is the TypeScript object literal order: a Go map would sort the
// keys, and the schema the model reads is part of the tool contract.
type kernelGraphLaneSubmitSchema struct {
	Type       string                          `json:"type"`
	Properties kernelGraphLaneSubmitProperties `json:"properties"`
	Required   []string                        `json:"required"`
}

// kernelGraphLaneSubmitProperties is the property list of the submit schema.
type kernelGraphLaneSubmitProperties struct {
	Outputs kernelGraphLaneSubmitOutputs `json:"outputs"`
}

// kernelGraphLaneSubmitOutputs is the per-output entry of the submit schema.
type kernelGraphLaneSubmitOutputs struct {
	Type                 string                           `json:"type"`
	Description          string                           `json:"description"`
	AdditionalProperties kernelGraphLaneSubmitOutputValue `json:"additionalProperties"`
}

// kernelGraphLaneSubmitOutputValue is the shape of one declared output.
type kernelGraphLaneSubmitOutputValue struct {
	Type       string                                `json:"type"`
	Properties kernelGraphLaneSubmitOutputProperties `json:"properties"`
	Required   []string                              `json:"required"`
}

// kernelGraphLaneSubmitOutputProperties are the fields of one declared output.
type kernelGraphLaneSubmitOutputProperties struct {
	Enable map[string]any `json:"enable"`
	Value  map[string]any `json:"value"`
}

// kernelGraphLaneSubmitTool is the node's graph output tool.
//
// The argument shape is part of the contract, not a detail the model has to guess: a
// call that puts its outputs anywhere else is refused by name (HB-324).
func kernelGraphLaneSubmitTool() PiWorkerTool {
	return PiWorkerTool{
		Name:  "submit",
		Label: "Submit",
		Description: "Submit this node's required outputs to the graph kernel. Call it as " +
			"{\"outputs\":{\"<output name>\":{\"enable\":true,\"value\":<value>}}}; every required output must appear with enable:true.",
		Parameters: kernelGraphLaneSubmitSchema{
			Type: "object",
			Properties: kernelGraphLaneSubmitProperties{
				Outputs: kernelGraphLaneSubmitOutputs{
					Type:        "object",
					Description: "One entry per output this node declares; enable:true for the required ones.",
					AdditionalProperties: kernelGraphLaneSubmitOutputValue{
						Type: "object",
						Properties: kernelGraphLaneSubmitOutputProperties{
							Enable: map[string]any{"type": "boolean"},
							Value:  map[string]any{},
						},
						Required: []string{"enable"},
					},
				},
			},
			Required: []string{"outputs"},
		},
	}
}
