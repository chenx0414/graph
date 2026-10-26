package graph

import (
	"regexp"
	"strconv"
	"strings"

	"fmt"
)

var (
	ipv4Part  = regexp.MustCompile(`^\d{1,3}$`)
	dnsLabel  = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	domainBad = regexp.MustCompile(`[\s/@:/?]`)
)

func ipv4Address(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 4 {
		return false
	}
	for _, part := range parts {
		if !ipv4Part.MatchString(part) {
			return false
		}
		number, err := strconv.Atoi(part)
		if err != nil || number > 255 {
			return false
		}
	}
	return true
}

// NormalizeDomainPattern validates one capability-declared domain pattern.
// Wildcards are limited to a leading `*.`. Invalid patterns panic with a plain error.
func NormalizeDomainPattern(value string) string {
	pattern := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(value)), ".")
	if pattern == "" || pattern == "*" || domainBad.MatchString(pattern) {
		panic(fmt.Errorf("Invalid domain pattern: %s", value))
	}
	wildcard := strings.HasPrefix(pattern, "*.")
	if wildcard {
		pattern = pattern[2:]
	}
	if pattern == "" || strings.Contains(pattern, "*") || len(pattern) > 253 {
		panic(fmt.Errorf("Invalid domain pattern: %s", value))
	}
	if ipv4Address(pattern) {
		if wildcard {
			panic(fmt.Errorf("IPv4 addresses cannot use a wildcard: %s", value))
		}
		return pattern
	}
	if wildcard && !strings.Contains(pattern, ".") {
		panic(fmt.Errorf("Wildcard domain is too broad: %s", value))
	}
	if !wildcard && pattern != "localhost" && !strings.Contains(pattern, ".") {
		panic(fmt.Errorf("Invalid domain pattern: %s", value))
	}
	for _, label := range strings.Split(pattern, ".") {
		if !dnsLabel.MatchString(label) {
			panic(fmt.Errorf("Invalid domain pattern: %s", value))
		}
	}
	if wildcard {
		return "*." + pattern
	}
	return pattern
}

// NormalizeDomains lowercases, dedupes and strips leading dots.
func NormalizeDomains(domains []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, domain := range domains {
		domain = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(domain)), ".")
		if domain == "" || seen[domain] {
			continue
		}
		seen[domain] = true
		out = append(out, domain)
	}
	if out == nil {
		return []string{}
	}
	return out
}

// SandboxNetworkDomains expands a bare domain to itself and its subtree.
func SandboxNetworkDomains(domains []string) []string {
	var expanded []string
	seen := map[string]bool{}
	add := func(domain string) {
		if seen[domain] {
			return
		}
		seen[domain] = true
		expanded = append(expanded, domain)
	}
	for _, domain := range NormalizeDomains(domains) {
		add(domain)
		if !strings.HasPrefix(domain, "*.") && !ipv4Address(domain) && domain != "localhost" {
			add("*." + domain)
		}
	}
	if expanded == nil {
		return []string{}
	}
	return expanded
}

// AllowedDomain reports whether hostname is covered by a granted domain.
func AllowedDomain(domains []string, hostname string) bool {
	host := strings.ToLower(hostname)
	for _, domain := range domains {
		if strings.HasPrefix(domain, "*.") {
			base := domain[2:]
			if base != "" && strings.HasSuffix(host, "."+base) {
				return true
			}
			continue
		}
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}
