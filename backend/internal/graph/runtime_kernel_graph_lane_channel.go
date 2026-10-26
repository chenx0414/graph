package graph

func (state *kernelGraphLaneState) modelChannel(graphId, nodeId string, session NodeSession, model ModelEntry, purpose string, raw any, hostSignal *AbortSignal, streamOptions WorkerModelOptions) (*kernelGraphLaneNodeChannel, error) {
	credential := state.options.CredentialFor(model)
	if credential == nil {
		panic(errorString("Bound model credential unavailable"))
	}
	context, _ := raw.(map[string]any)
	if context == nil {
		panic(errorString("Invalid model context"))
	}
	if _, ok := context["messages"].([]any); !ok {
		panic(errorString("Invalid model context"))
	}
	channel := &kernelGraphLaneNodeChannel{}
	gate := KernelProviderGate(state.options.Kernel, graphId, nodeId, nil, &model, &ProviderRecipe{
		Definition: session.Binding.DefinitionVersion, Review: session.Role == "reviewer",
	}, purpose)
	observed := SendGate{
		Dispatch: func(id string, reservation float64, send func() any) any {
			defer func() {
				recovered := recover()
				if recovered == nil {
					return
				}
				if failure, ok := recovered.(*RuntimeError); ok && (failure.Code == "paused" || failure.Code == "budget") {
					channel.refusal = failure
				}
				panic(recovered)
			}()
			return gate.Dispatch(id, reservation, send)
		},
		Settle: func(id string, cost *TokenUsage) {
			gate.Settle(id, cost)
			if cost == nil {
				channel.unknown = true
				return
			}
			channel.usage.Input += cost.Input
			channel.usage.Output += cost.Output
			channel.usage.CacheRead += cost.CacheRead
			channel.usage.CacheWrite += cost.CacheWrite
		},
	}
	execution := state.options.Kernel.RunningExecution(graphId, nodeId)
	if execution == nil {
		panic(errorString("No active execution"))
	}
	executionID := execution.Id
	abort := NewAbortSignal()
	cancel := func() { abort.Abort() }
	releases := []func(){}
	if hostSignal != nil {
		abortListener := hostSignal.AddEventListener("abort", cancel, true)
		releases = append(releases, func() { hostSignal.RemoveEventListener(abortListener) })
	}
	unsubscribe := state.options.Kernel.Store.OnEvent(func(string) {
		if state.options.Kernel.Store.Task(graphId).Phase == "stopping" {
			abort.Abort()
		}
	})
	releases = append(releases, unsubscribe)
	channel.release = func() {
		for _, release := range releases {
			release()
		}
	}
	slot := kernelGraphLaneSlot(state.options, model, credential, executionID)
	stream, err := ControlledOpenAIStream(observed, model, func(candidate ModelEntry) string {
		binding := state.options.CredentialFor(candidate)
		if binding == nil {
			panic(errorString("Bound model credential unavailable"))
		}
		return binding.ApiKey
	}, slot, model.Api, PiAdapterStreamOptions{
		EstimateMissing: kernelGraphLaneUnlimited(state.options.Kernel, executionID),
		OnRequest: func(callId string, profile map[string]any) {
			// The TypeScript event spreads the profile into the event object,
			// so the profile's own keys sit beside callId and model.
			event := map[string]any{
				"callId": callId, "executionId": executionID, "nodeId": nodeId, "model": model.Id,
				"rates": model.Cost, "pricing": model.Pricing,
			}
			for name, value := range profile {
				event[name] = value
			}
			state.options.Kernel.Store.Event(graphId, "provider.request_profile", event)
		},
		OnSend: func(sent PiAdapterSentRequest) {
			tools := "[]"
			if sent.ToolDeclarations != nil {
				tools = kernelGraphLaneJSON(sent.ToolDeclarations)
			}
			state.options.Kernel.RecordPrompt(graphId, nodeId, executionID, rsiStringValue(sent.SystemPrompt), tools)
		},
	})(ToPiModel(model), context, kernelGraphLaneStreamOptions(streamOptions, abort))
	if err != nil {
		channel.release()
		return nil, err
	}
	channel.inner = stream
	return channel, nil
}
