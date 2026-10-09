package deployment_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

// Real HEAD transport suppresses response bodies; a fake RoundTripper with an
// XML HEAD body would conceal the fixture protocol defect seen by the SDK.
func TestDeploymentOSSFixtureReportsDeletedObjectToRealSDK(t *testing.T) {
	public, private := providerCertificate(t)
	pair, err := tls.X509KeyPair(public, private)
	if err != nil {
		t.Fatal("fixture certificate preparation failed")
	}
	server := httptest.NewUnstartedServer(newDeploymentProviderFixtureHandler())
	server.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(public)
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr != "nevix-upgrade.oss-cn-hangzhou.aliyuncs.com:443" {
				return nil, errors.New("unexpected fixture origin")
			}
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		},
	}}
	defer client.CloseIdleConnections()
	cfg := oss.LoadDefaultConfig().WithRegion("cn-hangzhou").WithCredentialsProvider(credentials.NewStaticCredentialsProvider("fixture-access-key-348", "fixture-secret-key-348")).WithRetryMaxAttempts(1).WithHttpClient(client)
	sdk := oss.NewClient(cfg)
	ctx := context.Background()
	bucket, key := "nevix-upgrade", "nevix-canary/test/server"
	if _, err := sdk.PutObject(ctx, &oss.PutObjectRequest{Bucket: oss.Ptr(bucket), Key: oss.Ptr(key), Body: strings.NewReader("canary")}); err != nil {
		t.Fatal("real OSS fixture PUT failed (private error withheld)")
	}
	if _, err := sdk.HeadObject(ctx, &oss.HeadObjectRequest{Bucket: oss.Ptr(bucket), Key: oss.Ptr(key)}); err != nil {
		t.Fatal("real OSS fixture retained HEAD failed (private error withheld)")
	}
	if _, err := sdk.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(bucket), Key: oss.Ptr(key)}); err != nil {
		t.Fatal("real OSS fixture DELETE failed (private error withheld)")
	}
	_, err = sdk.HeadObject(ctx, &oss.HeadObjectRequest{Bucket: oss.Ptr(bucket), Key: oss.Ptr(key)})
	var serviceError *oss.ServiceError
	if !errors.As(err, &serviceError) || serviceError.StatusCode != http.StatusNotFound || serviceError.Code != "NoSuchKey" {
		t.Fatal("real OSS SDK did not receive NoSuchKey from deleted-object HEAD404 (private error withheld)")
	}
}
