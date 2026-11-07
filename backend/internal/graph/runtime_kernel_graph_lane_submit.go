package graph

type kernelGraphLaneSubmitSchema struct {
	Type       string                          `json:"type"`
	Properties kernelGraphLaneSubmitProperties `json:"properties"`
	Required   []string                        `json:"required"`
}

type kernelGraphLaneSubmitProperties struct {
	Outputs kernelGraphLaneSubmitOutputs `json:"outputs"`
}

type kernelGraphLaneSubmitOutputs struct {
	Type                 string                           `json:"type"`
	Description          string                           `json:"description"`
	AdditionalProperties kernelGraphLaneSubmitOutputValue `json:"additionalProperties"`
}

type kernelGraphLaneSubmitOutputValue struct {
	Type       string                                `json:"type"`
	Properties kernelGraphLaneSubmitOutputProperties `json:"properties"`
	Required   []string                              `json:"required"`
}

type kernelGraphLaneSubmitOutputProperties struct {
	Enable map[string]any `json:"enable"`
	Value  map[string]any `json:"value"`
}

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
