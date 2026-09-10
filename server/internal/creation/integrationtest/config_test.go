package integrationtest

import (
	"reflect"
	"sort"
	"testing"

	"github.com/nevix-ai/server/internal/creation"
)

func TestLoadConfigDoesNotReadLegacyStorageEnvironment(t *testing.T) {
	values := map[string]string{
		"CORS_ALLOWED_ORIGINS":       "http://127.0.0.1:5173",
		"NEVIX_CREATION_SECRETS_DIR": t.TempDir(),
		"KAPON_BASE_URL":             "http://127.0.0.1:9090",
		"STORAGE_BACKEND":            "filesystem",
		"STORAGE_FS_ROOT":            "/tmp/legacy-creation-blobs",
		"S3_ENDPOINT":                "legacy.invalid",
	}
	queried := make([]string, 0, 3)
	config, err := creation.LoadConfig(func(key string) (string, bool) {
		queried = append(queried, key)
		value, ok := values[key]
		return value, ok
	})
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.SecretsDir != values["NEVIX_CREATION_SECRETS_DIR"] || config.KaponBaseURL != values["KAPON_BASE_URL"] {
		t.Fatalf("LoadConfig returned unexpected process configuration: %#v", config)
	}
	sort.Strings(queried)
	want := []string{"CORS_ALLOWED_ORIGINS", "KAPON_BASE_URL", "NEVIX_CREATION_SECRETS_DIR"}
	if !reflect.DeepEqual(queried, want) {
		t.Fatalf("LoadConfig queried %v, want only %v", queried, want)
	}
}
