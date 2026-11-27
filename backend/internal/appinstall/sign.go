package appinstall

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	SigningIdentity = "Graph Self-Signed"
	CodeIdentifier  = "dev.graph.console"
)

var requestConfig = `[req]
distinguished_name = dn
x509_extensions = codesign
prompt = no
[dn]
CN = ` + SigningIdentity + `
O = Graph
[codesign]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
`

type Identity struct {
	Name     string
	Keychain string
}

func SigningDirectory() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".graph", "signing")
}

func KeychainPath() string {
	return filepath.Join(SigningDirectory(), "graph-signing.keychain-db")
}

func passwordPath() string {
	return filepath.Join(SigningDirectory(), "keychain.pass")
}

func keychainPassword(create bool) (string, error) {
	payload, err := os.ReadFile(passwordPath())
	if err == nil {
		return strings.TrimSpace(string(payload)), nil
	}
	if !create {
		return "", fmt.Errorf("the keychain password is missing at %s; delete %s and rerun to recreate the identity", passwordPath(), KeychainPath())
	}
	raw := make([]byte, 24)
	if _, readErr := rand.Read(raw); readErr != nil {
		return "", readErr
	}
	generated := hex.EncodeToString(raw)
	if writeErr := os.WriteFile(passwordPath(), []byte(generated+"\n"), 0o600); writeErr != nil {
		return "", writeErr
	}
	return generated, nil
}

func run(command string, args ...string) (string, error) {
	output, err := exec.Command(command, args...).CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%s %s: %v: %s", command, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

// IdentityPresent asks for a usable identity, not a *valid* one.
func IdentityPresent() bool {
	if _, err := os.Stat(KeychainPath()); err != nil {
		return false
	}
	output, err := run("security", "find-identity", "-p", "codesigning", KeychainPath())
	return err == nil && strings.Contains(output, SigningIdentity)
}

var ErrIdentityUnusable = errors.New("the signing identity exists but cannot sign")

func EnsureIdentity() (Identity, error) {
	identity := Identity{Name: SigningIdentity, Keychain: KeychainPath()}
	if IdentityPresent() {
		return identity, nil
	}
	if _, err := os.Stat(KeychainPath()); err == nil {
		return Identity{}, fmt.Errorf("%w: %s at %s does not list a valid %q identity. "+
			"Repair it in Keychain Access, or run with --repair-signing to replace it. "+
			"Replacing it changes the certificate, so macOS asks for Accessibility and "+
			"Screen Recording again", ErrIdentityUnusable, KeychainPath(), KeychainPath(), SigningIdentity)
	}
	if err := os.MkdirAll(SigningDirectory(), 0o700); err != nil {
		return Identity{}, err
	}
	password, err := keychainPassword(true)
	if err != nil {
		return Identity{}, err
	}
	scratch, err := os.MkdirTemp("", "graph-identity-")
	if err != nil {
		return Identity{}, err
	}
	defer os.RemoveAll(scratch)
	key := filepath.Join(scratch, "key.pem")
	certificate := filepath.Join(scratch, "cert.pem")
	bundle := filepath.Join(scratch, "identity.p12")
	config := filepath.Join(scratch, "request.cnf")
	if err := os.WriteFile(config, []byte(requestConfig), 0o600); err != nil {
		return Identity{}, err
	}
	if _, err := run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
		"-days", "3650", "-config", config); err != nil {
		return Identity{}, err
	}
	if _, err := run("openssl", "pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", bundle,
		"-passout", "pass:"+password, "-name", SigningIdentity,
		// macOS reads only the legacy PBE ciphers; OpenSSL 3 defaults to AES and
		// security import rejects that bundle.
		"-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "SHA1"); err != nil {
		return Identity{}, err
	}
	for _, step := range [][]string{
		{"create-keychain", "-p", password, KeychainPath()},
		{"set-keychain-settings", KeychainPath()},
		{"unlock-keychain", "-p", password, KeychainPath()},
		{"import", bundle, "-k", KeychainPath(), "-P", password, "-T", "/usr/bin/codesign", "-A"},
		{"set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, KeychainPath()},
	} {
		if _, err := run("security", step...); err != nil {
			return Identity{}, err
		}
	}
	if err := os.Chmod(KeychainPath(), 0o600); err != nil {
		return Identity{}, err
	}
	if !IdentityPresent() {
		return Identity{}, fmt.Errorf("%s could not be imported into %s", SigningIdentity, KeychainPath())
	}
	return identity, nil
}

func SignPackagedApp(bundle string) (string, error) {
	binary, err := bundleExecutable(bundle)
	if err != nil {
		return "", err
	}
	return InstallBundleSigning(bundle, binary)
}

func ResetIdentity() (Identity, error) {
	if err := os.Remove(KeychainPath()); err != nil && !os.IsNotExist(err) {
		return Identity{}, err
	}
	return EnsureIdentity()
}

type SignOptions struct {
	Identifier string
	Deep       bool
}

func SignCode(target string, options SignOptions) error {
	identity, err := EnsureIdentity()
	if err != nil {
		return err
	}
	password, err := keychainPassword(false)
	if err != nil {
		return err
	}
	if _, err := run("security", "unlock-keychain", "-p", password, identity.Keychain); err != nil {
		return err
	}
	args := []string{"--force", "--keychain", identity.Keychain, "--sign", SigningIdentity}
	if options.Identifier != "" {
		args = append(args, "--identifier", options.Identifier)
	}
	if options.Deep {
		args = append(args, "--deep")
	}
	args = append(args, target)
	_, err = run("codesign", args...)
	return err
}

func DesignatedRequirement(target string) (string, error) {
	output, err := run("codesign", "-dr-", target)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "=>") {
			return strings.TrimSpace(line), nil
		}
	}
	return strings.TrimSpace(output), nil
}

func SignatureIsStable(requirement string) bool {
	return strings.Contains(requirement, "certificate") && !strings.Contains(requirement, "cdhash")
}

var ErrNoExecutable = errors.New("the bundle carries no executable to sign")

func InstallBundleSigning(bundle, binary string) (string, error) {
	if _, err := os.Stat(binary); err != nil {
		return "", fmt.Errorf("%s has no executable at %s", bundle, binary)
	}
	if err := SignCode(binary, SignOptions{Identifier: CodeIdentifier}); err != nil {
		return "", err
	}
	if err := SignCode(bundle, SignOptions{}); err != nil {
		return "", err
	}
	if _, err := run("codesign", "--verify", "--strict", "--deep", bundle); err != nil {
		return "", err
	}
	return DesignatedRequirement(bundle)
}
