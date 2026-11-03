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
	// A send whose model configures a fallback may be taken over, and its failed
	// attempt is settled as producing nothing so the fallback can be sent.
	fallback := kernelGraphLaneFallback(state.options, model)
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
	// One send for one model: its own gate, credential and slot, so the provider
	// call of either attempt is charged to the model that really answered.
	var open func(candidate ModelEntry) (ModelEventStream, error)
	open = func(candidate ModelEntry) (ModelEventStream, error) {
		candidateCredential := state.options.CredentialFor(candidate)
		if candidateCredential == nil {
			return nil, errorString("Bound model credential unavailable")
		}
		gate := KernelProviderGate(state.options.Kernel, graphId, nodeId, nil, &candidate, &ProviderRecipe{
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
		slot := kernelGraphLaneSlot(state.options, candidate, candidateCredential, executionID)
		return ControlledOpenAIStream(observed, candidate, func(resolved ModelEntry) string {
			binding := state.options.CredentialFor(resolved)
			if binding == nil {
				panic(errorString("Bound model credential unavailable"))
			}
			return binding.ApiKey
		}, slot, candidate.Api, PiAdapterStreamOptions{
			EstimateMissing: kernelGraphLaneUnlimited(state.options.Kernel, executionID),
			HasFallback:     fallback != nil,
			OnRequest: func(callId string, profile map[string]any) {
				// The TypeScript event spreads the profile into the event object,
				// so the profile's own keys sit beside callId and model.
				event := map[string]any{
					"callId": callId, "executionId": executionID, "nodeId": nodeId, "model": candidate.Id,
					"rates": candidate.Cost, "pricing": candidate.Pricing,
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
		})(ToPiModel(candidate), context, kernelGraphLaneStreamOptions(streamOptions, abort))
	}
	stream, err := open(model)
	if err != nil {
		channel.release()
		return nil, err
	}
	channel.inner = StreamWithModelFallback(stream, model.Id, fallback, open, func(record ModelFallbackRecord) {
		// The four facts are recorded where the kernel keeps its own events: a
		// fallback that is not visible here would be the same as a model that
		// silently replaced another one.
		state.options.Kernel.Store.Event(graphId, "graph.provider.fallback", map[string]any{
			"nodeId": nodeId, "executionId": executionID,
			"primaryModel": record.PrimaryModel, "error": record.Error,
			"fallbackModel": record.FallbackModel, "sameModel": record.SameModel,
		})
	})
	return channel, nil
}

// kernelGraphLaneFallback is the model one entry falls back to when the provider
// boundary breaks, or nil when the entry configures none.
func kernelGraphLaneFallback(options KernelGraphLaneOptions, model ModelEntry) *ModelEntry {
	if model.FallbackModelId == "" || options.Directory == nil || model.FallbackModelId == model.Id {
		return nil
	}
	for _, candidate := range options.Directory() {
		if candidate.Id != model.FallbackModelId {
			continue
		}
		entry := candidate
		return &entry
	}
	return nil
}
