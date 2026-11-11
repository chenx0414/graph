package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type secretsFile struct {
	Version int               `json:"version"`
	Entries map[string]string `json:"entries"`
}

const (
	secretNonce   = 12
	secretKeySize = 32
)

func secretsKeyPath(path string) string { return path + ".key" }

func readSecretKey(path string) ([]byte, error) {
	key, err := os.ReadFile(secretsKeyPath(path))
	if err != nil {
		return nil, err
	}
	if len(key) != secretKeySize {
		return nil, errors.New("the secrets key is not 32 bytes")
	}
	return key, nil
}

func ensureSecretKey(path string) ([]byte, error) {
	if key, err := readSecretKey(path); err == nil {
		return key, nil
	}
	key := make([]byte, secretKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(secretsKeyPath(path)), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(secretsKeyPath(path), key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func readSecrets(path string) (secretsFile, error) {
	file := secretsFile{Version: 1, Entries: map[string]string{}}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return file, nil
		}
		return file, err
	}
	if err := json.Unmarshal(payload, &file); err != nil {
		return secretsFile{Version: 1, Entries: map[string]string{}}, err
	}
	if file.Entries == nil {
		file.Entries = map[string]string{}
	}
	if file.Version == 0 {
		file.Version = 1
	}
	return file, nil
}

func writeSecrets(path string, file secretsFile) error {
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o600)
}

func sealSecret(key []byte, value string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, secretNonce)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, nonce, []byte(value), nil)
	payload := make([]byte, 0, len(nonce)+len(sealed))
	payload = append(payload, nonce...)
	payload = append(payload, sealed...)
	return base64.StdEncoding.EncodeToString(payload), nil
}

func unsealSecret(key []byte, encoded string) (string, error) {
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	if len(payload) < secretNonce+16 {
		return "", errors.New("the sealed value is too short")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := aead.Open(nil, payload[:secretNonce], payload[secretNonce:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func saveSecret(path, ref string, value *string) error {
	file, err := readSecrets(path)
	if err != nil {
		file = secretsFile{Version: 1, Entries: map[string]string{}}
	}
	if value == nil {
		delete(file.Entries, ref)
		return writeSecrets(path, file)
	}
	key, err := ensureSecretKey(path)
	if err != nil {
		return err
	}
	sealed, err := sealSecret(key, *value)
	if err != nil {
		return err
	}
	file.Entries[ref] = sealed
	return writeSecrets(path, file)
}

func secretStatus(path string, refs []string) map[string]bool {
	status := map[string]bool{}
	file, err := readSecrets(path)
	for _, ref := range refs {
		status[ref] = false
	}
	if err != nil {
		return status
	}
	key, keyErr := readSecretKey(path)
	if keyErr != nil {
		return status
	}
	for _, ref := range refs {
		sealed, present := file.Entries[ref]
		if !present {
			continue
		}
		if _, err := unsealSecret(key, sealed); err == nil {
			status[ref] = true
		}
	}
	return status
}

func secretValues(path string) map[string]string {
	values := map[string]string{}
	file, err := readSecrets(path)
	if err != nil {
		return values
	}
	key, err := readSecretKey(path)
	if err != nil {
		return values
	}
	for ref, sealed := range file.Entries {
		if value, err := unsealSecret(key, sealed); err == nil {
			values[ref] = value
		}
	}
	return values
}

func secretsPath(stateDir string) string {
	return filepath.Join(stateDir, "secrets.json")
}
