package storage

import (
	"testing"
)

func TestNormalizeLocationDerivesOnlyOfficialPublicOrigins(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		input      Location
		want       Location
		wantOrigin string
	}{
		{
			name:       "OSS",
			input:      Location{Provider: " OSS ", Region: " CN-Hangzhou ", Bucket: " Nevix-Media "},
			want:       Location{Provider: ProviderOSS, Region: "cn-hangzhou", Bucket: "nevix-media"},
			wantOrigin: "https://nevix-media.oss-cn-hangzhou.aliyuncs.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := NormalizeLocation(tt.input)
			if err != nil {
				t.Fatalf("NormalizeLocation: %v", err)
			}
			if got != tt.want {
				t.Fatalf("location = %#v, want %#v", got, tt.want)
			}
			if got.Origin() != tt.wantOrigin {
				t.Fatalf("origin = %q, want %q", got.Origin(), tt.wantOrigin)
			}
		})
	}
}

func TestNormalizeLocationRejectsUnsupportedOrNonCanonicalLocations(t *testing.T) {
	t.Parallel()

	tests := []Location{
		{Provider: "s3", Region: "us-east-1", Bucket: "bucket"},
		{Provider: "filesystem", Region: "cn-hangzhou", Bucket: "bucket"},
		{Provider: "cos", Region: "ap-shanghai", Bucket: "bucket-1250000000"},
		{Provider: ProviderOSS, Region: "oss-cn-hangzhou-internal", Bucket: "bucket"},
		{Provider: ProviderOSS, Region: "cn-hangzhou", Bucket: "bucket.aliyuncs.com"},
		{Provider: ProviderOSS, Region: "cn-hangzhou", Bucket: "-bucket"},
	}

	for _, input := range tests {
		input := input
		t.Run(string(input.Provider)+"/"+input.Region+"/"+input.Bucket, func(t *testing.T) {
			t.Parallel()
			if _, err := NormalizeLocation(input); err == nil {
				t.Fatalf("NormalizeLocation(%#v) succeeded", input)
			}
		})
	}
}

func TestFactoryConstructsOSSWithoutConnecting(t *testing.T) {
	t.Parallel()

	location := Location{Provider: ProviderOSS, Region: "cn-hangzhou", Bucket: "bucket"}
	got, err := NewBlobStore(location, Credentials{AccessKeyID: "ak", SecretAccessKey: "sk"})
	if err != nil {
		t.Fatalf("NewBlobStore: %v", err)
	}
	if _, ok := got.(*ossStore); !ok {
		t.Fatalf("selected OSS, got %T", got)
	}
	if _, err := NewReferenceTransport(location, Credentials{AccessKeyID: "ak", SecretAccessKey: "sk"}); err != nil {
		t.Fatalf("NewReferenceTransport: %v", err)
	}
}
