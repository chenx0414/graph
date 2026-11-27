package appinstall

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// signingFixture puts the signing directory under the test's temp home, so a test
// never touches the identity the installed app uses.
func signingFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return filepath.Join(home, ".graph", "signing")
}

// machoBinary compiles a real Mach-O executable. A shell script is not one:
// codesign reads its host requirement instead of the one we set.
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

// makeKeychainWithoutIdentity creates an unlocked keychain that holds no
// code-signing identity, which is what a signing setup looks like when its
// certificate is missing or unusable.
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

// requireTooling skips only when the host genuinely lacks the tools: an
// assertion that silently passes without codesign proves nothing.
func requireTooling(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"codesign", "security", "openssl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not on PATH", tool)
		}
	}
}

// The identity a signature names must be a certificate, not a content hash: TCC
// grants permission to a certificate requirement and revokes it when the cdhash
// changes, which is every rebuild.
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

// A second install must reuse the identity: a rebuilt app that reuses nothing
// forces the user to grant permission again.
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

// An identity that exists but cannot sign must be reported, never silently
// repaired: deleting the keychain replaces the certificate and takes the user's
// permission with it.
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

// The install path must fail loudly when the stable identity is unavailable.
// Falling back to an ad-hoc signature is what shipped: the app ran, and the
// permission it had been granted no longer applied to it.
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
	// The fallback signed the bundle with a throwaway identity. The bundle itself
	// must still be unsigned, which is what "the install did nothing" looks like:
	// the executable inside it carries the ad-hoc signature the Go toolchain put
	// there, and that one is not the installer's doing.
	if err := exec.Command("codesign", "--verify", bundle).Run(); err == nil {
		out, _ := exec.Command("codesign", "-dvv", bundle).CombinedOutput()
		t.Fatalf("the bundle was signed instead of refusing: %s", strings.TrimSpace(string(out)))
	}
}
