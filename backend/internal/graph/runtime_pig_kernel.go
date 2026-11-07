package graph

import (
	"encoding/json"
	"fmt"

	"github.com/MichaelKinsy/PiG/durable/harness"

	"os"
	"path/filepath"
	"strings"

	"context"

	"github.com/MichaelKinsy/PiG/durable"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

type PigKernelConversation struct {
	Id                int64 `json:"id"`
	OwnerConversation int64 `json:"ownerConversation"`
	OwnerTask         int64 `json:"ownerTask"`
	Entries           int   `json:"entries"`
}

type PigKernelReport struct {
	Database      string                  `json:"database"`
	Prefix        string                  `json:"prefix"`
	SchemaVersion int                     `json:"schemaVersion"`
	Conversations []PigKernelConversation `json:"conversations"`
	Submissions   int                     `json:"submissions"`
	Tasks         int                     `json:"tasks"`
}

func InspectPigKernel(database string) (PigKernelReport, error) {
	ctx := context.Background()
	registry := harness.CreateRegistry()
	kernel, err := pigkernel.Open(ctx, pigkernel.Options{Database: database, Registry: registry})
	if err != nil {
		return PigKernelReport{}, err
	}
	defer func() { _ = kernel.Close() }()
	report := PigKernelReport{Database: database, Prefix: pigkernel.DurablePrefix}
	version, err := pigkernel.DurableSchemaVersion(ctx, kernel)
	if err != nil {
		return PigKernelReport{}, err
	}
	report.SchemaVersion = version
	page, err := kernel.Storage().ScanConversations(ctx, durable.ConversationQuery{}, 1000, nil)
	if err != nil {
		return PigKernelReport{}, err
	}
	for _, conversation := range page.Items {
		found := PigKernelConversation{Id: int64(conversation.Id)}
		if conversation.Owner != nil {
			found.OwnerConversation = int64(conversation.Owner.ConversationId)
			found.OwnerTask = int64(conversation.Owner.TaskId)
		}
		entries, err := kernel.Storage().ScanEntries(ctx, durable.EntryQuery{ConversationId: conversation.Id}, 1000, nil)
		if err != nil {
			return PigKernelReport{}, err
		}
		found.Entries = len(entries.Items)
		report.Conversations = append(report.Conversations, found)
	}
	submissions, err := kernel.Storage().ScanSubmissions(ctx, durable.SubmissionQuery{}, 1000, nil)
	if err != nil {
		return PigKernelReport{}, err
	}
	report.Submissions = len(submissions.Items)
	tasks, err := kernel.Storage().ScanTasks(ctx, durable.TaskQuery{}, 1000, nil)
	if err != nil {
		return PigKernelReport{}, err
	}
	report.Tasks = len(tasks.Items)
	return report, nil
}

func PrintPigKernelReport(database string) error {
	report, err := InspectPigKernel(database)
	if err != nil {
		return err
	}
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}
	fmt.Println(string(body))
	return nil
}

type PigKernelTurnOptions struct {
	Database string
	ModelId string
	Prompt string
	Identity string
	Workspace string
	McpServers []pigkernel.McpServerSpec
	Instructions string
}

func RunPigKernelTurn(config GraphConfig, options PigKernelTurnOptions) (pigkernel.TurnResult, error) {
	entry, err := configuredModel(config, options.ModelId)
	if err != nil {
		return pigkernel.TurnResult{}, err
	}
	key, err := modelCredential(config, entry)
	if err != nil {
		return pigkernel.TurnResult{}, err
	}
	api := "openai-completions"
	switch entry.Api {
	case "anthropic-messages":
		api = "anthropic-messages"
	case "openai-responses":
		api = "openai-responses"
	}
	spec := pigkernel.ModelSpec{
		ProviderID:    entry.Provider,
		Id:            entry.ModelId,
		Name:          entry.Id,
		API:           api,
		BaseURL:       entry.BaseUrl,
		APIKey:        key,
		Headers:       entry.Headers,
		ContextWindow: entry.ContextWindow,
		MaxTokens:     entry.MaxTokens,
		Reasoning:     entry.Reasoning == nil || *entry.Reasoning,
		Input:         modelInputNames(entry.Input),
	}
	if spec.Id == "" {
		spec.Id = entry.Id
	}
	tools := []pigkernel.ToolSpec{}
	if options.Workspace != "" {
		tools = append(tools, workspaceReadTool(options.Workspace))
	}
	return pigkernel.RunTurn(context.Background(), pigkernel.TurnOptions{
		Database:     options.Database,
		Identity:     options.Identity,
		Model:        spec,
		Tools:        tools,
		McpServers:   options.McpServers,
		Instructions: options.Instructions,
		Prompt:       options.Prompt,
	})
}

func configuredModel(config GraphConfig, modelId string) (ConfiguredModel, error) {
	if config.Models == nil {
		return ConfiguredModel{}, fmt.Errorf("graph: no models are configured")
	}
	for _, entry := range config.Models.Entries {
		if entry.Id == modelId {
			return entry, nil
		}
	}
	return ConfiguredModel{}, fmt.Errorf("graph: the model %s is not configured", modelId)
}

func modelCredential(config GraphConfig, entry ConfiguredModel) (string, error) {
	if entry.CredentialId == "" {
		return "", fmt.Errorf("graph: the model %s has no credential", entry.Id)
	}
	credential, ok := config.Credentials[entry.CredentialId]
	if !ok {
		return "", fmt.Errorf("graph: the credential %s is not configured", entry.CredentialId)
	}
	value, ok := os.LookupEnv(credential.SecretRef)
	if !ok || value == "" {
		return "", fmt.Errorf("graph: the credential %s has no value", entry.CredentialId)
	}
	return value, nil
}

func workspaceReadTool(workspace string) pigkernel.ToolSpec {
	root, err := filepath.Abs(workspace)
	if err != nil {
		root = workspace
	}
	return pigkernel.ToolSpec{
		Name:        "read",
		Description: "Read a file from the workspace.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "The path of the file to read."},
			},
			"required": []any{"path"},
		},
		Execute: func(ctx context.Context, args map[string]any) (string, error) {
			path, _ := args["path"].(string)
			if path == "" {
				return "", fmt.Errorf("read needs a path")
			}
			resolved := path
			if !filepath.IsAbs(resolved) {
				resolved = filepath.Join(root, resolved)
			}
			resolved = filepath.Clean(resolved)
			if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
				return "", fmt.Errorf("read is limited to the workspace")
			}
			body, err := os.ReadFile(resolved)
			if err != nil {
				return "", err
			}
			if len(body) > 64*1024 {
				body = body[:64*1024]
			}
			return string(body), nil
		},
	}
}

func PrintPigKernelTurn(opts cliOptions, env map[string]string) error {
	if opts.kernelModel == "" {
		return fmt.Errorf("graph: --kernel-model is required for a kernel turn")
	}
	if opts.kernelPrompt == "" {
		return fmt.Errorf("graph: --kernel-prompt is required for a kernel turn")
	}
	config := LoadGraphConfig(opts.configPath)
	workspace := ""
	if len(config.Projects) > 0 {
		workspace = config.Projects[0].Root
	}
	servers, err := loadKernelMcpServers(opts.kernelMcp)
	if err != nil {
		return err
	}
	result, err := RunPigKernelTurn(config, PigKernelTurnOptions{
		Database:   opts.kernelDatabase,
		ModelId:    opts.kernelModel,
		Prompt:     opts.kernelPrompt,
		Identity:   opts.kernelIdentity,
		Workspace:  workspace,
		McpServers: servers,
	})
	if err != nil {
		return err
	}
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	fmt.Println(string(body))
	return nil
}

func McpServerSpecFrom(name string, definition *McpServerDefinition) pigkernel.McpServerSpec {
	spec := pigkernel.McpServerSpec{Name: name}
	if definition == nil {
		return spec
	}
	spec.Command = definition.Command
	spec.Args = definition.Args
	spec.Env = definition.Env
	spec.URL = definition.Url
	spec.Headers = definition.Headers
	return spec
}

type kernelMcpFile struct {
	Servers []struct {
		Name    string            `json:"name"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Cwd     string            `json:"cwd"`
		Env     map[string]string `json:"env"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	} `json:"servers"`
}

func loadKernelMcpServers(path string) ([]pigkernel.McpServerSpec, error) {
	if path == "" {
		return nil, nil
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file kernelMcpFile
	if err := json.Unmarshal(body, &file); err != nil {
		return nil, fmt.Errorf("graph: the MCP server file is malformed: %w", err)
	}
	servers := []pigkernel.McpServerSpec{}
	for _, server := range file.Servers {
		servers = append(servers, pigkernel.McpServerSpec{
			Name:    server.Name,
			Command: server.Command,
			Args:    server.Args,
			Cwd:     server.Cwd,
			Env:     server.Env,
			URL:     server.URL,
			Headers: server.Headers,
		})
	}
	return servers, nil
}
