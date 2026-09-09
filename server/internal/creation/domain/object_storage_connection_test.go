package domain

import "testing"

func TestObjectStorageLocationAndMaskedCredentialProjection(t *testing.T) {
	connection := ObjectStorageConnection{
		ObjectStorageLocation: ObjectStorageLocation{
			Provider: ObjectStorageProviderOSS,
			Region:   "cn-hangzhou",
			Bucket:   "nevix-private",
		},
		AccessKeyIDMasked: MaskObjectStorageAccessKeyID("LTAI5tExample1234"),
	}
	if got := connection.Origin(); got != "https://nevix-private.oss-cn-hangzhou.aliyuncs.com" {
		t.Fatalf("OSS upload origin = %q", got)
	}
	if connection.AccessKeyIDMasked != "****1234" {
		t.Fatalf("masked access key = %q", connection.AccessKeyIDMasked)
	}

	connection.Provider = ObjectStorageProviderCOS
	connection.Region = "ap-shanghai"
	connection.Bucket = "nevix-private-1250000000"
	if got := connection.Origin(); got != "https://nevix-private-1250000000.cos.ap-shanghai.myqcloud.com" {
		t.Fatalf("COS upload origin = %q", got)
	}
	if got := MaskObjectStorageAccessKeyID("abc"); got != "****abc" {
		t.Fatalf("short masked access key = %q", got)
	}
}
