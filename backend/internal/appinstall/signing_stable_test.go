package appinstall

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func signingFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return filepath.Join(home, ".graph", "signing")
}

func machoBinary(t *testing.T, path string) {
	t.Helper()
	source := filepath.Join(t.TempDir(), "main.go")
	if err := os.WriteFile(source, []byte("package main\n\nfunc main() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", path, source)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build a test binary: %v: %s", err, output)
	}
}

func makeKeychainWithoutIdentity(t *testing.T, directory string) error {
	t.Helper()
	path := filepath.Join(directory, "graph-signing.keychain-db")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(directory, "keychain.pass"), []byte("secret\n"), 0o600); err != nil {
		return err
	}
	output, err := exec.Command("security", "create-keychain", "-p", "secret", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("create-keychain: %v: %s", err, output)
	}
	if output, err := exec.Command("security", "unlock-keychain", "-p", "secret", path).CombinedOutput(); err != nil {
		return fmt.Errorf("unlock-keychain: %v: %s", err, output)
	}
	return nil
}

func requireTooling(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"codesign", "security", "openssl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not on PATH", tool)
		}
	}
}

// A rebuild must not change what the signature names.
func TestAStableIdentitySignsWithACertificateRequirement(t *testing.T) {
	requireTooling(t)
	signingFixture(t)
	scratch := t.TempDir()
	bundle := filepath.Join(scratch, "Graph.app")
	if err := os.MkdirAll(filepath.Join(bundle, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	machoBinary(t, executable)
	requirement, err := InstallBundleSigning(bundle, executable)
	if err != nil {
		t.Fatalf("sign with the stable identity: %v", err)
	}
	if !SignatureIsStable(requirement) {
		t.Fatalf("the requirement must name the certificate, got %q", requirement)
	}
	if !strings.Contains(requirement, "identifier") {
		t.Fatalf("the requirement must name the identifier, got %q", requirement)
	}
}

func TestTwoInstallsReuseTheSameIdentity(t *testing.T) {
	requireTooling(t)
	signingFixture(t)
	first, err := EnsureIdentity()
	if err != nil {
		t.Fatalf("first identity: %v", err)
	}
	before, err := os.ReadFile(first.Keychain)
	if err != nil {
		t.Fatal(err)
	}
	second, err := EnsureIdentity()
	if err != nil {
		t.Fatalf("second identity: %v", err)
	}
	after, err := os.ReadFile(second.Keychain)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) || string(before) != string(after) {
		t.Fatalf("the second call rebuilt the keychain instead of reusing it (%d bytes, then %d)", len(before), len(after))
	}
}

// An unusable identity is reported, never replaced.
func TestAnUnusableIdentityIsReportedNotReplaced(t *testing.T) {
	requireTooling(t)
	directory := signingFixture(t)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "graph-signing.keychain-db"), []byte("not a keychain"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "keychain.pass"), []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, "graph-signing.keychain-db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureIdentity(); err == nil {
		t.Fatal("an unusable keychain must be an error, not a silent rebuild")
	}
	after, err := os.ReadFile(filepath.Join(directory, "graph-signing.keychain-db"))
	if err != nil {
		t.Fatalf("the existing keychain must survive the failure: %v", err)
	}
	if string(before) != string(after) {
		t.Fatal("the identity must not be deleted when it cannot be used; that is what makes every rebuild ask again")
	}
}

// Installing refuses an ad-hoc signature.
func TestInstallRefusesToFallBackToAnAdHocSignature(t *testing.T) {
	requireTooling(t)
	directory := signingFixture(t)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	// A real keychain with no usable identity: the cert is there, but nothing can
	// sign with it. That is the state a rebuilt app lands in, and the installer
	// must refuse rather than leave the bundle ad-hoc signed.
	if err := makeKeychainWithoutIdentity(t, directory); err != nil {
		t.Fatalf("build a keychain without an identity: %v", err)
	}
	scratch := t.TempDir()
	bundle := filepath.Join(scratch, "Graph.app")
	if err := os.MkdirAll(filepath.Join(bundle, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	machoBinary(t, executable)
	err := signInstalled(bundle)
	if err == nil {
		t.Fatal("the installer must fail when the stable identity cannot sign")
	}
	if !strings.Contains(err.Error(), "identity") && !strings.Contains(err.Error(), SigningIdentity) {
		t.Fatalf("the error must name what to fix, got %v", err)
	}
	// The fallback signed the bundle; it must still be unsigned instead.
	if err := exec.Command("codesign", "--verify", bundle).Run(); err == nil {
		out, _ := exec.Command("codesign", "-dvv", bundle).CombinedOutput()
		t.Fatalf("the bundle was signed instead of refusing: %s", strings.TrimSpace(string(out)))
	}
}

// The packaged bundle carries the stable signature too.
func TestAPackagedBundleCarriesTheStableSignature(t *testing.T) {
	requireTooling(t)
	signingFixture(t)
	scratch := t.TempDir()
	bundle := filepath.Join(scratch, "Graph.app")
	if err := os.MkdirAll(filepath.Join(bundle, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(bundle, "Contents", "MacOS", "Graph")
	machoBinary(t, executable)
	requirement, err := SignPackagedApp(bundle)
	if err != nil {
		t.Fatalf("sign the packaged bundle: %v", err)
	}
	if !SignatureIsStable(requirement) {
		t.Fatalf("the packaged bundle must carry a certificate requirement, got %q", requirement)
	}
	if out, err := exec.Command("codesign", "--verify", "--strict", "--deep", bundle).CombinedOutput(); err != nil {
		t.Fatalf("the packaged bundle must verify: %v: %s", err, out)
	}
}

// A rebuild must keep the requirement macOS keys the grant on, though the CDHash moves.
func TestARebuildKeepsTheRequirementMacOSKeysTheGrantOn(t *testing.T) {
	requireTooling(t)
	signingFixture(t)
	rebuild := func() (string, string) {
		scratch := t.TempDir()
		bundle := filepath.Join(scratch, "Graph.app")
		if err := os.MkdirAll(filepath.Join(bundle, "Contents", "MacOS"), 0o755); err != nil {
			t.Fatal(err)
		}
		executable := filepath.Join(bundle, "Contents", "MacOS", "Graph")
		machoBinary(t, executable)
		requirement, err := SignPackagedApp(bundle)
		if err != nil {
			t.Fatalf("sign the rebuilt bundle: %v", err)
		}
		output, err := exec.Command("codesign", "-d", "--verbose=4", bundle).CombinedOutput()
		if err != nil {
			t.Fatalf("read the CDHash: %v: %s", err, output)
		}
		hash := ""
		for _, line := range strings.Split(string(output), "\n") {
			if strings.HasPrefix(line, "CDHash=") {
				hash = strings.TrimPrefix(line, "CDHash=")
			}
		}
		if hash == "" {
			t.Fatalf("the bundle carries no CDHash: %s", output)
		}
		return requirement, hash
	}
	firstRequirement, firstHash := rebuild()
	secondRequirement, secondHash := rebuild()
	if firstHash == secondHash {
		t.Fatalf("the two builds signed the same bytes (%s); this test cannot tell a rotating identity from a stable one", firstHash)
	}
	if firstRequirement != secondRequirement {
		t.Fatalf("a rebuild changed the requirement macOS keys the grant on: %q, then %q", firstRequirement, secondRequirement)
	}
	if !SignatureIsStable(secondRequirement) {
		t.Fatalf("the rebuilt bundle must name the certificate, got %q", secondRequirement)
	}
}
