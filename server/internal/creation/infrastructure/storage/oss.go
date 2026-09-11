package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type ossStore struct {
	client   *oss.Client
	location Location
}

func newOSSStore(raw Location, credentialsValue Credentials, httpClient *http.Client) (*ossStore, error) {
	location, err := NormalizeLocation(raw)
	if err != nil {
		return nil, err
	}
	if location.Provider != ProviderOSS {
		return nil, errors.New("creation: OSS adapter requires provider oss")
	}
	if strings.TrimSpace(credentialsValue.AccessKeyID) == "" || strings.TrimSpace(credentialsValue.SecretAccessKey) == "" {
		return nil, errors.New("creation: OSS credentials are required")
	}
	config := oss.LoadDefaultConfig().
		WithRegion(location.Region).
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(credentialsValue.AccessKeyID, credentialsValue.SecretAccessKey)).
		WithRetryMaxAttempts(1)
	if httpClient != nil {
		config.WithHttpClient(httpClient)
	}
	return &ossStore{client: oss.NewClient(config), location: location}, nil
}

func (s *ossStore) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (domain.PutResult, error) {
	return s.put(ctx, key, src, maxBytes, "", nil)
}

func (s *ossStore) putProviderTransfer(ctx context.Context, key string, src io.Reader, maxBytes int64, contentType string, metadata map[string]string) (domain.PutResult, error) {
	return s.put(ctx, key, src, maxBytes, contentType, metadata)
}

func (s *ossStore) put(ctx context.Context, key string, src io.Reader, maxBytes int64, contentType string, metadata map[string]string) (domain.PutResult, error) {
	result, err := streamBoundedPut(ctx, src, maxBytes, func(body io.Reader) error {
		request := &oss.PutObjectRequest{
			Bucket:          oss.Ptr(s.location.Bucket),
			Key:             oss.Ptr(key),
			Body:            body,
			ForbidOverwrite: oss.Ptr("true"),
			Metadata:        metadata,
		}
		if contentType != "" {
			request.ContentType = oss.Ptr(contentType)
		}
		_, putErr := s.client.PutObject(ctx, request)
		return safeOSSError("put", putErr)
	})
	if err != nil {
		return domain.PutResult{}, err
	}
	return result, nil
}

func (s *ossStore) presignGet(ctx context.Context, key string, expiresIn time.Duration) (string, error) {
	result, err := s.client.Presign(ctx, &oss.GetObjectRequest{
		Bucket: oss.Ptr(s.location.Bucket),
		Key:    oss.Ptr(key),
	}, oss.PresignExpires(expiresIn))
	if err != nil {
		return "", safeOSSError("presign get", err)
	}
	if result.Method != http.MethodGet || len(result.SignedHeaders) != 0 {
		return "", fmt.Errorf("creation: OSS presign GET contract: %w", domain.ErrObjectStorageUnavailable)
	}
	if err := validatePresignedOrigin(result.URL, s.location.Origin()); err != nil {
		return "", err
	}
	return result.URL, nil
}

func (s *ossStore) Head(ctx context.Context, key string) (domain.BlobInfo, error) {
	result, err := s.client.HeadObject(ctx, &oss.HeadObjectRequest{
		Bucket: oss.Ptr(s.location.Bucket),
		Key:    oss.Ptr(key),
	})
	if err != nil {
		return domain.BlobInfo{}, safeOSSError("head", err)
	}
	metadata := make(map[string]string, len(result.Metadata))
	for name, value := range result.Metadata {
		metadata[strings.ToLower(name)] = value
	}
	return domain.BlobInfo{
		ByteSize:    result.ContentLength,
		ContentType: oss.ToString(result.ContentType),
		Metadata:    metadata,
	}, nil
}

func (s *ossStore) Open(ctx context.Context, key string, rng domain.BlobRange) (domain.ReadSeekCloser, int64, error) {
	info, err := s.Head(ctx, key)
	if err != nil {
		return nil, 0, err
	}
	window := newRemoteWindow(ctx, rng, info.ByteSize, func(ctx context.Context, start, stop int64) (io.ReadCloser, error) {
		rawRange := fmt.Sprintf("bytes=%d-%d", start, stop-1)
		result, getErr := s.client.GetObject(ctx, &oss.GetObjectRequest{
			Bucket:        oss.Ptr(s.location.Bucket),
			Key:           oss.Ptr(key),
			Range:         oss.Ptr(rawRange),
			RangeBehavior: oss.Ptr("standard"),
		})
		if getErr != nil {
			return nil, safeOSSError("open", getErr)
		}
		return result.Body, nil
	})
	return window, info.ByteSize, nil
}

func (s *ossStore) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &oss.DeleteObjectRequest{
		Bucket: oss.Ptr(s.location.Bucket),
		Key:    oss.Ptr(key),
	})
	if mapped := safeOSSError("delete", err); errors.Is(mapped, domain.ErrBlobNotFound) {
		return nil
	} else {
		return mapped
	}
}

func (s *ossStore) PresignPut(ctx context.Context, request domain.PresignPutRequest) (domain.PresignedPut, error) {
	if err := validatePresignPutRequest(request); err != nil {
		return domain.PresignedPut{}, err
	}
	result, err := s.client.Presign(ctx, &oss.PutObjectRequest{
		Bucket:          oss.Ptr(s.location.Bucket),
		Key:             oss.Ptr(request.Key),
		ContentType:     oss.Ptr(request.ContentType),
		Metadata:        map[string]string{domain.UploadIDMetadataKey: request.UploadID},
		ForbidOverwrite: oss.Ptr("true"),
	}, oss.PresignExpires(request.ExpiresIn))
	if err != nil {
		return domain.PresignedPut{}, safeOSSError("presign put", err)
	}
	if err := validatePresignedOrigin(result.URL, s.location.Origin()); err != nil {
		return domain.PresignedPut{}, err
	}
	headers := map[string]string{
		"Content-Type":           request.ContentType,
		"X-Oss-Meta-Upload-Id":   request.UploadID,
		"X-Oss-Forbid-Overwrite": "true",
	}
	if !signedHeadersContain(result.SignedHeaders, headers) {
		return domain.PresignedPut{}, fmt.Errorf("creation: OSS presign headers: %w", domain.ErrObjectStorageUnavailable)
	}
	return domain.PresignedPut{
		Method:    result.Method,
		URL:       result.URL,
		Headers:   headers,
		ExpiresAt: result.Expiration,
	}, nil
}

func safeOSSError(operation string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("creation: OSS %s canceled: %w", operation, err)
	}
	var serviceErr *oss.ServiceError
	if errors.As(err, &serviceErr) {
		switch serviceErr.Code {
		case "NoSuchKey":
			return fmt.Errorf("creation: OSS %s: %w", operation, domain.ErrBlobNotFound)
		case "FileAlreadyExists":
			return fmt.Errorf("creation: OSS %s: %w", operation, domain.ErrBlobConflict)
		}
		return fmt.Errorf("creation: OSS %s: %w", operation, classifyCloudServiceStatus(serviceErr.StatusCode))
	}
	return fmt.Errorf("creation: OSS %s: %w", operation, domain.ErrObjectStorageUnavailable)
}

func validatePresignPutRequest(request domain.PresignPutRequest) error {
	if strings.TrimSpace(request.Key) == "" || strings.TrimSpace(request.ContentType) == "" || strings.TrimSpace(request.UploadID) == "" {
		return errors.New("creation: presigned PUT requires key, content type, and upload id")
	}
	if request.ExpiresIn <= 0 || request.ExpiresIn > 7*24*time.Hour {
		return errors.New("creation: presigned PUT expiry must be positive and at most seven days")
	}
	return nil
}

func validatePresignedOrigin(rawURL, wantOrigin string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme+"://"+parsed.Host != wantOrigin {
		return fmt.Errorf("creation: provider returned unexpected presigned origin: %w", domain.ErrObjectStorageUnavailable)
	}
	return nil
}

func signedHeadersContain(got, want map[string]string) bool {
	headers := make(http.Header, len(got))
	for name, value := range got {
		headers.Set(name, value)
	}
	for name, value := range want {
		if headers.Get(name) != value {
			return false
		}
	}
	return true
}
