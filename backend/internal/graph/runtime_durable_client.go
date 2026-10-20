package graph

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// One SDK owner shares the formal Graph database across main and graph nodes.
// Model credentials and tool admission stay in this Go process.
type durableOwner struct {
	command *exec.Cmd
	input   io.WriteCloser
	address string
	done    chan struct{}
	stderr  *piWorkerStderrBuffer
}

var durableOwners = struct {
	sync.Mutex
	values map[string]*durableOwner
}{values: map[string]*durableOwner{}}

func ensureDurableOwner(database string) (*durableOwner, error) {
	if agentKernelMode() == AgentKernelPig {
		// The PiG kernel owns the durable namespace in this process. The
		// TypeScript sidecar would open the same tables with the same
		// schema, and two kernels over one namespace corrupt each other's
		// records. The paths that still need the sidecar - the graph node lane
		// and the crash recovery - are refused here rather than silently
		// fighting over the tables.
		return nil, fmt.Errorf("The TypeScript durable sidecar is not available on the PiG kernel: the graph node lane and the crash recovery still need it")
	}
	durableOwners.Lock()
	defer durableOwners.Unlock()
	if owner := durableOwners.values[database]; owner != nil {
		select {
		case <-owner.done:
			delete(durableOwners.values, database)
		default:
			return owner, nil
		}
	}
	runtime, electron := GraphNodeRuntime(nil)
	// A short, private path avoids the platform's Unix socket path limit.
	scratch, err := os.MkdirTemp("", "graph-durable-")
	if err != nil {
		return nil, err
	}
	address := filepath.Join(scratch, "sdk.sock")
	command := exec.Command(runtime, filepath.Join(GraphApplicationRoot(), "src", "runtime", "durable-service.ts"), database, address, filepath.Join(filepath.Dir(database), "instances"))
	command.Env = durableHostEnvironment(electron)
	stderr := &piWorkerStderrBuffer{}
	command.Stderr = stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err = command.Start(); err != nil {
		os.RemoveAll(scratch)
		return nil, err
	}
	owner := &durableOwner{command: command, input: input, address: address, done: make(chan struct{}), stderr: stderr}
	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		announced := false
		for scanner.Scan() {
			if !announced && scanner.Text() == "durable ready" {
				announced = true
				ready <- nil
			}
		}
		if !announced {
			ready <- fmt.Errorf("durable SDK host failed: %s", stderr.String())
		}
	}()
	go func() { _ = command.Wait(); close(owner.done); _ = os.RemoveAll(scratch) }()
	select {
	case err = <-ready:
		if err != nil {
			_ = command.Process.Kill()
			return nil, err
		}
	case <-time.After(30 * time.Second):
		_ = command.Process.Kill()
		return nil, fmt.Errorf("durable SDK startup timed out: %s", stderr.String())
	}
	durableOwners.values[database] = owner
	return owner, nil
}

func closeDurableOwner(database string) {
	durableOwners.Lock()
	owner := durableOwners.values[database]
	delete(durableOwners.values, database)
	durableOwners.Unlock()
	if owner == nil {
		return
	}
	_ = owner.command.Process.Signal(os.Interrupt)
	select {
	case <-owner.done:
	case <-time.After(5 * time.Second):
		_ = owner.command.Process.Kill()
		<-owner.done
	}
	_ = owner.input.Close()
}

type durableReply struct {
	Value json.RawMessage
	Error string
}
type durableClient struct {
	owner      *durableOwner
	connection net.Conn
	mutex      sync.Mutex
	writeMutex sync.Mutex
	pending    map[string]chan durableReply
	failure    error
	callback   func(string, map[string]any) (any, error)
	latest     AgentSessionInspect
}

func openDurableClient(database string, config any, callback func(string, map[string]any) (any, error)) (*durableClient, error) {
	owner, err := ensureDurableOwner(database)
	if err != nil {
		return nil, err
	}
	connection, err := net.Dial("unix", owner.address)
	if err != nil {
		return nil, err
	}
	client := &durableClient{owner: owner, connection: connection, pending: map[string]chan durableReply{}, callback: callback}
	go client.read()
	if config != nil {
		if err = client.call("open", durablePublicConfig(config), &client.latest); err != nil {
			_ = connection.Close()
			return nil, err
		}
	}
	return client, nil
}
func (client *durableClient) write(value any) error {
	client.writeMutex.Lock()
	defer client.writeMutex.Unlock()
	return json.NewEncoder(client.connection).Encode(value)
}
func (client *durableClient) read() {
	decoder := json.NewDecoder(client.connection)
	for {
		var message struct {
			ReplyTo string          `json:"replyTo"`
			Value   json.RawMessage `json:"value"`
			Error   string          `json:"error"`
			CallID  string          `json:"callId"`
			Kind    string          `json:"kind"`
			Params  json.RawMessage `json:"params"`
		}
		if err := decoder.Decode(&message); err != nil {
			client.mutex.Lock()
			client.failure = err
			for id, pending := range client.pending {
				pending <- durableReply{Error: "Durable SDK disconnected: " + err.Error()}
				delete(client.pending, id)
			}
			client.mutex.Unlock()
			return
		}
		if message.ReplyTo != "" {
			client.mutex.Lock()
			pending := client.pending[message.ReplyTo]
			delete(client.pending, message.ReplyTo)
			client.mutex.Unlock()
			if pending != nil {
				pending <- durableReply{Value: message.Value, Error: message.Error}
			}
			continue
		}
		if message.CallID == "" {
			continue
		}
		execute := func() {
			var value any
			var failure error
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						failure = fmt.Errorf("%v", recovered)
					}
				}()
				var params map[string]any
				_ = json.Unmarshal(message.Params, &params)
				if params == nil {
					params = map[string]any{}
				}
				value, failure = client.callback(message.Kind, params)
			}()
			response := map[string]any{"replyTo": message.CallID, "value": value}
			if failure != nil {
				response["error"] = failure.Error()
			}
			_ = client.write(response)
		}
		if message.Kind == "event" || message.Kind == "telemetry" {
			execute()
		} else {
			go execute()
		}
	}
}
func (client *durableClient) call(method string, params any, output any) error {
	id := graphUUID()
	reply := make(chan durableReply, 1)
	client.mutex.Lock()
	if client.failure != nil {
		err := client.failure
		client.mutex.Unlock()
		return err
	}
	client.pending[id] = reply
	client.mutex.Unlock()
	if err := client.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		client.mutex.Lock()
		delete(client.pending, id)
		client.mutex.Unlock()
		return err
	}
	answer := <-reply
	if answer.Error != "" {
		return errors.New(answer.Error)
	}
	if output != nil && len(answer.Value) > 0 {
		return json.Unmarshal(answer.Value, output)
	}
	return nil
}
func (client *durableClient) close() error {
	err := client.call("close", nil, nil)
	_ = client.connection.Close()
	return err
}

type durableAgentTransport struct{ database string }

func CreateDurableAgentSessionTransport(store *TaskStore) AgentSessionTransport {
	return &durableAgentTransport{database: store.Path}
}
func (transport *durableAgentTransport) Open(request AgentSessionRequest) (AgentSession, error) {
	config := durableRequestConfig(request)
	callback := durableRequestCallback(request)
	client, err := openDurableClient(transport.database, config, callback)
	if err != nil {
		return nil, err
	}
	return &durableAgentSession{client: client}, nil
}
func durableRequestCallback(request AgentSessionRequest) func(string, map[string]any) (any, error) {
	tools := map[string]func(string, map[string]any, context.Context) any{}
	for _, tool := range request.Tools {
		tools[tool.Name] = piWorkerGatedTool(tool, request.Broker)
	}
	requests := CreateWorkerRequests(struct {
		Broker    *CallBroker
		Model     any
		Stream    PromptStreamFunc
		Resources map[string]struct {
			URL     string
			Headers map[string]string
		}
		Tools                 map[string]func(string, map[string]any, context.Context) any
		AllowedNativeTools    []string
		AllowedExtensionTools []string
		OnEvent               func(any)
	}{Model: request.Model, Stream: request.Stream, Tools: tools, AllowedNativeTools: request.NativeTools, AllowedExtensionTools: request.PiExtensionTools, OnEvent: func(event any) {
		if request.OnEvent != nil {
			request.OnEvent(asMap(event))
		}
	}})
	return func(kind string, params map[string]any) (any, error) {
		if kind == "native_gate" {
			if !containsString(request.NativeTools, mapString(params, "name")) && !containsString(request.PiExtensionTools, mapString(params, "name")) {
				return nil, fmt.Errorf("Unknown native tool admission")
			}
			id := mapString(params, "id")
			request.Broker.Dispatch(id, 0, func() any { return nil })
			return nil, nil
		}
		if kind == "native_settle" {
			request.Broker.Settle(mapString(params, "id"), &TokenUsage{})
			return nil, nil
		}
		if kind == "telemetry" {
			if request.OnToolCall != nil {
				body, _ := json.Marshal(params)
				var call PiAdapterToolCall
				_ = json.Unmarshal(body, &call)
				request.OnToolCall(call)
			}
			return nil, nil
		}
		if kind == "cancel" {
			requests.Cancel(mapString(params, "target"))
			return nil, nil
		}
		if kind == "event" {
			return requests.Call(map[string]any{"operation": "event", "event": params}), nil
		}
		params["operation"] = kind
		return requests.Call(params), nil
	}
}

type durableAgentSession struct{ client *durableClient }

func (session *durableAgentSession) Prompt(text string, images []ImageContent) (AgentSessionTurn, error) {
	var turn AgentSessionTurn
	err := session.client.call("prompt", map[string]any{"text": text, "images": images}, &turn)
	session.client.latest = turn.Inspect
	return turn, err
}
func (session *durableAgentSession) Compact(text string) error {
	return session.client.call("compact", map[string]any{"text": text}, &session.client.latest)
}
func (session *durableAgentSession) Steer(text string) error {
	return session.client.call("steer", map[string]any{"text": text}, nil)
}
func (session *durableAgentSession) Interrupt(text *string) error {
	return session.client.call("interrupt", map[string]any{"text": text}, nil)
}
func (session *durableAgentSession) Stop() error                  { return session.client.call("stop", nil, nil) }
func (session *durableAgentSession) Inspect() AgentSessionInspect { return session.client.latest }
func (session *durableAgentSession) Close() error                 { return session.client.close() }

func durableRequestConfig(request AgentSessionRequest) map[string]any {
	config := BuildPiWorkerConfig(request, PiWorkerResolved{Workspace: request.Workspace, StateDir: request.StateDir, SkillPaths: request.SkillPaths, PiExtensionPaths: request.PiExtensionPaths, SkillFolder: stringPointer(request.SkillFolder)})
	body, _ := json.Marshal(config)
	values := map[string]any{}
	_ = json.Unmarshal(body, &values)
	values["executionConfiguration"] = request.ExecutionConfiguration
	values["nodeExecutionConfiguration"] = request.NodeExecutionConfiguration
	values["capabilityDescriptor"] = request.CapabilityDescriptor
	values["credentialReference"] = request.CredentialReference
	values["executionId"] = request.ExecutionId
	values["inputRequestId"] = request.InputRequestId
	values["readRoots"] = request.ReadRoots
	values["writeRoots"] = request.WriteRoots
	values["readOnly"] = request.ReadOnly
	values["filesystemAccess"] = request.FilesystemAccess
	values["protectedPaths"] = request.ProtectedPaths
	values["allowGitMetadataWritesAll"] = request.AllowGitMetadataWritesAll
	values["env"] = request.Env
	values["networkDomains"] = request.NetworkDomains
	values["allowUnrestrictedNetwork"] = request.AllowUnrestrictedNetwork
	values["allowLocalBinding"] = request.AllowLocalBinding
	values["unixSockets"] = request.UnixSockets
	values["allowAllUnixSockets"] = request.AllowAllUnixSockets
	values["allowAppleEvents"] = request.AllowAppleEvents
	return values
}

func (host *ResidentHost) startDurable() (ResidentInspect, error) {
	owner, err := ensureDurableOwner(host.options.Config.DurableDatabase)
	if err != nil {
		return ResidentInspect{}, err
	}
	host.mutex.Lock()
	defer host.mutex.Unlock()
	if host.disposed {
		return ResidentInspect{}, errors.New("Durable node binding is closed")
	}
	host.durableOwner = owner
	host.durableStarted = true
	return ResidentInspect{ProcessId: owner.command.Process.Pid}, nil
}

func (host *ResidentHost) turnDurable(text string) (ResidentTurnResult, error) {
	config := map[string]any{}
	for key, value := range host.options.Config.DurableRequest {
		config[key] = value
	}
	if host.options.DurableInput == nil {
		return ResidentTurnResult{}, errors.New("Durable node input identity is missing")
	}
	requestID := host.options.DurableInput()
	if requestID == "" {
		return ResidentTurnResult{}, errors.New("Durable node execution is missing")
	}
	config["inputRequestId"] = requestID
	callback := host.durableCallback()
	client, err := openDurableClient(host.options.Config.DurableDatabase, config, callback)
	if err != nil {
		return ResidentTurnResult{}, err
	}
	host.mutex.Lock()
	host.durable = client
	host.mutex.Unlock()
	defer func() {
		_ = client.close()
		host.mutex.Lock()
		if host.durable == client {
			host.durable = nil
		}
		host.mutex.Unlock()
	}()
	if host.options.OnReady != nil {
		body, _ := json.Marshal(client.latest)
		var inspect ResidentInspect
		_ = json.Unmarshal(body, &inspect)
		host.options.OnReady(inspect)
	}
	var turn AgentSessionTurn
	if err = client.call("prompt", map[string]any{"text": text}, &turn); err != nil {
		return ResidentTurnResult{}, err
	}
	if turn.ErrorMessage != nil {
		return ResidentTurnResult{}, errors.New(*turn.ErrorMessage)
	}
	body, _ := json.Marshal(turn.Inspect)
	var inspect ResidentInspect
	_ = json.Unmarshal(body, &inspect)
	result := ResidentTurnResult{TurnId: requestID, Inspect: inspect}
	if host.options.DurableUsage != nil {
		result.Usage = host.options.DurableUsage()
	}

	return result, nil
}

func (host *ResidentHost) durableCallback() func(string, map[string]any) (any, error) {
	return func(kind string, params map[string]any) (any, error) {
		switch kind {
		case "model":
			if host.options.OnModelCall == nil {
				return nil, errors.New("Host model transport unavailable")
			}
			abort := NewAbortSignal()
			host.mutex.Lock()
			host.modelAborts[abort] = true
			host.mutex.Unlock()
			defer func() { host.mutex.Lock(); delete(host.modelAborts, abort); host.mutex.Unlock() }()
			value, err := host.options.OnModelCall(params["context"], abort, WorkerModelOptionsOf(params["options"]))
			return value, err
		case "native_gate", "native_settle":
			name := "native_tool_start"
			if kind == "native_settle" {
				name = "native_tool_settle"
			}
			if host.options.OnToolCall == nil {
				return nil, errors.New("Native tool admission unavailable")
			}
			answer, err := host.options.OnToolCall(name, params)
			if err != nil {
				return nil, err
			}
			if !answer.Ok {
				return nil, errors.New(answer.Text)
			}
			return nil, nil
		case "tool":
			if host.options.OnToolCall == nil {
				return nil, errors.New("Tool admission unavailable")
			}
			answer, err := host.options.OnToolCall(mapString(params, "name"), params["args"])
			if err != nil {
				return nil, err
			}
			var value any
			if json.Unmarshal([]byte(answer.Text), &value) != nil {
				value = map[string]any{"content": []any{map[string]any{"type": "text", "text": answer.Text}}, "isError": !answer.Ok}
			}
			if record := asMap(value); record != nil && !answer.Ok {
				record["isError"] = true
			}
			return value, nil
		case "event":
			if host.options.OnEvent != nil {
				host.options.OnEvent(params)
			}
			return nil, nil
		case "cancel":
			host.mutex.Lock()
			for signal := range host.modelAborts {
				signal.Abort()
			}
			host.mutex.Unlock()
			return nil, nil
		case "telemetry":
			if host.options.OnTelemetry != nil {
				body, _ := json.Marshal(params)
				var call PiAdapterToolCall
				_ = json.Unmarshal(body, &call)
				host.options.OnTelemetry(call)
			}
			return nil, nil
		}
		return nil, errors.New("Unsupported durable callback")
	}
}

func durableHostEnvironment(electron string) []string {
	allowed := []string{"HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GRAPH_APP_ROOT", "GRAPH_APP_NODE_BIN", "GRAPH_RESTRICTED_NODE_BIN"}
	values := []string{}
	for _, key := range allowed {
		if value, ok := os.LookupEnv(key); ok {
			values = append(values, key+"="+value)
		}
	}
	if electron != "" {
		values = append(values, "ELECTRON_RUN_AS_NODE=1")
	}
	return values
}

// Model credentials are resolved by the Go provider callback. The SDK only
// receives the model shape; named credential references remain recoverable.
func durablePublicConfig(config any) map[string]any {
	body, err := json.Marshal(config)
	if err != nil {
		panic(err)
	}
	values := map[string]any{}
	if err := json.Unmarshal(body, &values); err != nil {
		panic(err)
	}
	reference := asMap(values["credentialReference"])
	if reference == nil {
		reference = map[string]any{}
		values["credentialReference"] = reference
	}
	names := map[string]bool{}
	for _, name := range durableStrings(reference["headerCredentials"]) {
		names[name] = true
	}
	models := []map[string]any{asMap(values["model"]), asMap(asMap(values["executionConfiguration"])["model"]), asMap(asMap(values["nodeExecutionConfiguration"])["model"])}
	for _, model := range models {
		headers := asMap(model["headers"])
		for name := range headers {
			key := strings.ToLower(name)
			if key == "authorization" || key == "proxy-authorization" || key == "cookie" || key == "set-cookie" || key == "x-api-key" || key == "api-key" || strings.HasSuffix(key, "token") || strings.HasSuffix(key, "secret") || strings.HasSuffix(key, "password") {
				names[name] = true
				delete(headers, name)
			}
		}
	}
	headers := []string{}
	for name := range names {
		headers = append(headers, name)
	}
	sort.Strings(headers)
	reference["headerCredentials"] = headers

	return values
}

func restoreDurableModelHeaders(configuration map[string]any, model *ModelEntry, directory []ModelEntry) {
	names := durableStrings(configuration["headerCredentials"])
	for _, name := range names {
		found := false
		for _, entry := range directory {
			if entry.Id != model.Id {
				continue
			}
			for key, value := range ModelRequestHeaders(entry) {
				if strings.EqualFold(key, name) {
					if model.Headers == nil {
						model.Headers = map[string]string{}
					}
					model.Headers[name] = value
					found = true
					break
				}
			}
		}
		if !found {
			panic(fmt.Errorf("Original credential header %s is unavailable for model %s", name, model.Id))
		}
	}
}
