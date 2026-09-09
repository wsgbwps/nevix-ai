package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

var canaryPayload = []byte("nevix object storage canary")

// VerifyConnection checks one candidate through its selected production adapter.
func VerifyConnection(ctx context.Context, candidate domain.ObjectStorageCandidate) (domain.ObjectStorageLocation, error) {
	location, err := NormalizeLocation(Location{
		Provider: Provider(candidate.Location.Provider),
		Region:   candidate.Location.Region,
		Bucket:   candidate.Location.Bucket,
	})
	if err != nil {
		return domain.ObjectStorageLocation{}, domain.ErrInvalidObjectStorageCandidate
	}
	store, err := NewBlobStore(location, Credentials{
		AccessKeyID:     candidate.Credentials.AccessKeyID,
		SecretAccessKey: candidate.Credentials.SecretAccessKey,
	})
	if err != nil {
		return domain.ObjectStorageLocation{}, domain.ErrObjectStorageUnavailable
	}
	prefix := "nevix-canary/" + domain.NewUUID().String()
	if err := verifyConnectionCanary(ctx, location, store, http.DefaultClient, prefix); err != nil {
		return domain.ObjectStorageLocation{}, domain.ErrObjectStorageUnavailable
	}
	return domain.ObjectStorageLocation{
		Provider: domain.ObjectStorageProvider(location.Provider),
		Region:   location.Region,
		Bucket:   location.Bucket,
	}, nil
}

func verifyConnectionCanary(ctx context.Context, location Location, store domain.DirectUploadBlobStore, client *http.Client, prefix string) (resultErr error) {
	serverKey := prefix + "/server"
	signedKey := prefix + "/signed"
	keys := []string{serverKey, signedKey}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		for _, key := range keys {
			if err := store.Delete(cleanupCtx, key); err != nil {
				resultErr = domain.ErrObjectStorageUnavailable
			}
		}
	}()

	if _, err := store.Put(ctx, serverKey, bytes.NewReader(canaryPayload), int64(len(canaryPayload))); err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	info, err := store.Head(ctx, serverKey)
	if err != nil || info.ByteSize != int64(len(canaryPayload)) {
		return domain.ErrObjectStorageUnavailable
	}
	if err := requirePrivateAnonymousGet(ctx, client, objectURL(location.Origin(), serverKey)); err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	if err := verifyOpen(ctx, store, serverKey); err != nil {
		return domain.ErrObjectStorageUnavailable
	}

	signed, err := store.PresignPut(ctx, domain.PresignPutRequest{
		Key: signedKey, ContentType: "application/octet-stream", UploadID: "canary", ExpiresIn: 10 * time.Minute,
	})
	if err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	if err := requireOriginNullPreflight(ctx, client, signed); err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	if status := executeSignedPut(ctx, client, signed, canaryPayload); status < 200 || status >= 300 {
		return domain.ErrObjectStorageUnavailable
	}
	if status := executeSignedPut(ctx, client, signed, []byte("overwrite")); status != http.StatusConflict {
		return domain.ErrObjectStorageUnavailable
	}
	info, err = store.Head(ctx, signedKey)
	if err != nil || info.ByteSize != int64(len(canaryPayload)) || info.ContentType != "application/octet-stream" || info.Metadata[domain.UploadIDMetadataKey] != "canary" {
		return domain.ErrObjectStorageUnavailable
	}

	for _, key := range keys {
		if err := store.Delete(ctx, key); err != nil {
			return domain.ErrObjectStorageUnavailable
		}
		if _, err := store.Head(ctx, key); !errors.Is(err, domain.ErrBlobNotFound) {
			return domain.ErrObjectStorageUnavailable
		}
	}
	return nil
}

func verifyOpen(ctx context.Context, store domain.DirectUploadBlobStore, key string) error {
	reader, size, err := store.Open(ctx, key, domain.FullBlobRange)
	if err != nil {
		return err
	}
	full, readErr := io.ReadAll(io.LimitReader(reader, int64(len(canaryPayload)+1)))
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || size != int64(len(canaryPayload)) || !bytes.Equal(full, canaryPayload) {
		return domain.ErrObjectStorageUnavailable
	}

	reader, size, err = store.Open(ctx, key, domain.BlobRange{Offset: 6, Length: 6})
	if err != nil {
		return err
	}
	window, readErr := io.ReadAll(io.LimitReader(reader, 7))
	closeErr = reader.Close()
	if readErr != nil || closeErr != nil || size != int64(len(canaryPayload)) || string(window) != "object" {
		return domain.ErrObjectStorageUnavailable
	}
	return nil
}

func requirePrivateAnonymousGet(ctx context.Context, client *http.Client, rawURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	resp, err := client.Do(req)
	if err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	drainAndClose(resp.Body)
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		return domain.ErrObjectStorageUnavailable
	}
	return nil
}

func requireOriginNullPreflight(ctx context.Context, client *http.Client, signed domain.PresignedPut) error {
	names := make([]string, 0, len(signed.Headers))
	for name := range signed.Headers {
		names = append(names, strings.ToLower(name))
	}
	sort.Strings(names)
	req, err := http.NewRequestWithContext(ctx, http.MethodOptions, signed.URL, nil)
	if err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	req.Header.Set("Origin", "null")
	req.Header.Set("Access-Control-Request-Method", http.MethodPut)
	req.Header.Set("Access-Control-Request-Headers", strings.Join(names, ","))
	resp, err := client.Do(req)
	if err != nil {
		return domain.ErrObjectStorageUnavailable
	}
	drainAndClose(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.Header.Get("Access-Control-Allow-Origin") != "null" {
		return domain.ErrObjectStorageUnavailable
	}
	if !headerListContains(resp.Header.Get("Access-Control-Allow-Methods"), http.MethodPut) {
		return domain.ErrObjectStorageUnavailable
	}
	for _, name := range names {
		if !headerListContains(resp.Header.Get("Access-Control-Allow-Headers"), name) {
			return domain.ErrObjectStorageUnavailable
		}
	}
	return nil
}

func executeSignedPut(ctx context.Context, client *http.Client, signed domain.PresignedPut, body []byte) int {
	req, err := http.NewRequestWithContext(ctx, signed.Method, signed.URL, bytes.NewReader(body))
	if err != nil {
		return 0
	}
	for name, value := range signed.Headers {
		req.Header.Set(name, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	drainAndClose(resp.Body)
	return resp.StatusCode
}

func headerListContains(raw, expected string) bool {
	for _, value := range strings.Split(raw, ",") {
		if strings.EqualFold(strings.TrimSpace(value), expected) {
			return true
		}
	}
	return false
}

func objectURL(origin, key string) string {
	parsed, _ := url.Parse(origin)
	parsed.Path = "/" + key
	return parsed.String()
}

func drainAndClose(body io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 4096))
	_ = body.Close()
}
