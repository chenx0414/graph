package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

func usageSummarize(plans []UsagePlan) UsageSummary {
	summary := UsageSummary{}
	for _, plan := range plans {
		if plan.Configured {
			summary.Configured++
			if plan.Status != UsageStatusError {
				summary.Connected++
			}
		} else {
			summary.Unconfigured++
		}
		switch plan.Status {
		case UsageStatusWarning:
			summary.Warnings++
		case UsageStatusLimited:
			summary.Limited++
		}
	}
	return summary
}

type usageService struct {
	mu           sync.Mutex
	env          map[string]string
	home         string
	loadConfig   func() (GraphConfig, map[string]string)
	pricingPath  string
	openCodePath string
	cached       *UsageSnapshot
	loading      bool
	loaded       chan struct{}
	lastResult   UsageSnapshot
	lastError    error
}

func CreateUsageService(options UsageServiceOptions) UsageService {
	env := options.Env
	if env == nil {
		env = osEnviron()
	}
	home := options.Home
	if home == "" {
		home = strings.TrimSpace(env["HOME"])
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return &usageService{
		env: env, home: home, loadConfig: options.LoadConfig,
		pricingPath:  filepath.Join(home, ".cc-switch", "model-pricing.json"),
		openCodePath: filepath.Join(home, ".config", "opencode", "opencode.json"),
	}
}

func (service *usageService) usageCurrentConfig() (GraphConfig, map[string]string) {
	if service.loadConfig != nil {
		return service.loadConfig()
	}
	return EmptyGraphConfig(), service.env
}

func (service *usageService) usageCredentialInventory(config GraphConfig, env map[string]string, openCodeConfig any) map[UsageProviderId]*usageCredential {
	chatgpt, chatgptError := usageChatGptCredential(service.home, env)
	if chatgptError != nil {
		chatgpt = nil
	}
	grok, grokError := usageGrokCredential(service.home, env)
	if grokError != nil {
		grok = nil
	}
	return map[UsageProviderId]*usageCredential{
		UsageProviderOpenCodeGo:  usageOpenCodeCredential(&config, env, openCodeConfig),
		UsageProviderCommandGoat: usageCommandGoatCredential(&config, env, openCodeConfig),
		UsageProviderDeepSeek:    usageDeepSeekCredential(&config, env),
		UsageProviderChatGPT:     chatgpt,
		UsageProviderGrok:        grok,
	}
}

func (service *usageService) usageLoadPricing() ModelPricingSnapshot {
	snapshot := ModelPricingSnapshot{Source: "kernel catalog", Models: kernelModelPrices()}
	known := map[string]bool{}
	for _, price := range snapshot.Models {
		known[price.ModelID] = true
	}
	if info, err := os.Stat(service.pricingPath); err == nil {
		millis := info.ModTime().UnixMilli()
		snapshot.UpdatedAt = &millis
	}
	raw, err := readUsageJSONSafe(service.pricingPath)
	if err != nil || raw == nil {
		return snapshot
	}
	kept := []ModelPrice{}
	for _, price := range usageParseModelPrices(raw) {
		if known[price.ModelID] {
			continue
		}
		kept = append(kept, price)
	}
	if len(kept) > 0 {
		snapshot.Source = "kernel catalog + ~/.cc-switch/model-pricing.json"
		snapshot.Models = append(snapshot.Models, kept...)
		sort.SliceStable(snapshot.Models, func(left, right int) bool {
			return snapshot.Models[left].ModelID < snapshot.Models[right].ModelID
		})
	}
	return snapshot
}

type usageJob struct {
	platform   UsageProviderId
	planID     string
	account    *UsageAccount
	credential *usageCredential
	run        func() (UsagePlan, error)
}

func (service *usageService) usageLoad() (UsageSnapshot, error) {
	generatedAt := NowMillis()
	config, env := service.usageCurrentConfig()
	openCodeConfig, err := readUsageJSONSafe(service.openCodePath)
	if err != nil {
		openCodeConfig = nil
	}
	pricing := service.usageLoadPricing()
	credentials := service.usageCredentialInventory(config, env, openCodeConfig)
	prices := pricing.Models

	runners := map[UsageProviderId]func(*usageCredential) (UsagePlan, error){
		UsageProviderOpenCodeGo: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchOpenCode(credential, generatedAt, prices, openCodeConfig)
		},
		UsageProviderCommandGoat: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchCommandGoat(credential, generatedAt, prices, openCodeConfig)
		},
		UsageProviderDeepSeek: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchDeepSeek(credential, prices)
		},
		UsageProviderChatGPT: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchChatGpt(credential, prices)
		},
		UsageProviderGrok: func(credential *usageCredential) (UsagePlan, error) {
			return usageFetchGrok(credential, generatedAt, prices)
		},
	}

	jobs := []usageJob{}
	for _, platform := range usageProviderOrder {
		credential := credentials[platform]
		jobs = append(jobs, usageJob{
			platform: platform, planID: string(platform), account: nil, credential: credential,
			run: func() (UsagePlan, error) {
				if credential == nil {
					return usageBasePlan(platform, false, UsageStatusUnconfigured), nil
				}
				return runners[platform](credential)
			},
		})
		for _, account := range usagePlatformAccountCredentials(&config, env, platform) {
			if credential != nil && account.ID == credential.ID {
				continue
			}
			accountCopy := account
			jobs = append(jobs, usageJob{
				platform: platform, planID: string(platform) + "#" + account.ID,
				account:    &UsageAccount{ID: account.ID, Name: account.DisplayNameValue()},
				credential: &accountCopy,
				run: func() (UsagePlan, error) {
					if accountCopy.Value == "" {
						return usageBasePlan(platform, false, UsageStatusUnconfigured), nil
					}
					return runners[platform](&accountCopy)
				},
			})
		}
	}

	plans := make([]UsagePlan, len(jobs))
	var group sync.WaitGroup
	for index := range jobs {
		group.Add(1)
		go func(position int) {
			defer group.Done()
			job := jobs[position]
			plan, runError := job.run()
			if runError == nil {
				plan.ID = job.planID
				plan.Platform = job.platform
				plan.Account = job.account
				plans[position] = plan
				return
			}
			failed := usageBasePlan(job.platform, true, UsageStatusError)
			failed.ID = job.planID
			failed.Account = job.account
			if job.credential != nil {
				info := usageCredentialInfo(job.credential)
				failed.Credential = &info
				failed.CredentialSource = providerStringPointer(job.credential.Source)
			}
			message := usageErrorMessage(runError)
			failed.Error = &message
			plans[position] = failed
		}(index)
	}
	group.Wait()

	return UsageSnapshot{
		GeneratedAt: generatedAt,
		Plans:       plans,
		Pricing:     pricing,
		Summary:     usageSummarize(plans),
	}, nil
}

func (service *usageService) Get(force bool) (UsageSnapshot, error) {
	for {
		service.mu.Lock()
		if !force && service.cached != nil && NowMillis()-service.cached.GeneratedAt < usageCacheTTLMs {
			snapshot := *service.cached
			service.mu.Unlock()
			return snapshot, nil
		}
		if service.loading {
			done := service.loaded
			service.mu.Unlock()
			<-done
			service.mu.Lock()
			result := service.lastResult
			err := service.lastError
			service.mu.Unlock()
			return result, err
		}
		service.loading = true
		service.loaded = make(chan struct{})
		done := service.loaded
		service.mu.Unlock()

		snapshot, err := service.usageLoad()

		service.mu.Lock()
		service.loading = false
		service.lastResult = snapshot
		service.lastError = err
		if err == nil {
			cached := snapshot
			service.cached = &cached
		}
		service.mu.Unlock()
		close(done)
		return snapshot, err
	}
}

func (service *usageService) Pricing() (ModelPricingSnapshot, error) {
	return service.usageLoadPricing(), nil
}

func (service *usageService) Credentials() (map[string]string, error) {
	config, env := service.usageCurrentConfig()
	openCodeConfig, err := readUsageJSONSafe(service.openCodePath)
	if err != nil {
		openCodeConfig = nil
	}
	inventory := service.usageCredentialInventory(config, env, openCodeConfig)
	credentials := map[string]string{}
	for _, provider := range usageProviderOrder {
		if credential := inventory[provider]; credential != nil {
			credentials[string(provider)] = credential.SecretRef
		}
	}
	return credentials, nil
}

func (service *usageService) SecretValues() map[string]string {
	config, env := service.usageCurrentConfig()
	openCodeConfig, err := readUsageJSONSafe(service.openCodePath)
	if err != nil {
		openCodeConfig = nil
	}
	inventory := service.usageCredentialInventory(config, env, openCodeConfig)
	values := map[string]string{}
	for _, provider := range usageProviderOrder {
		if credential := inventory[provider]; credential != nil {
			values[credential.SecretRef] = credential.Value
		}
	}
	return values
}

func (credential *usageCredential) DisplayNameValue() string {
	if credential.DisplayName == nil {
		return credential.ID
	}
	return *credential.DisplayName
}

func readUsageJSONSafe(path string) (any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}
