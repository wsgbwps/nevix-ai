package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	cos "github.com/tencentyun/cos-go-sdk-v5"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type cosStore struct {
	client   *cos.Client
	location Location
}

func newCOSStore(raw Location, credentials Credentials, baseHTTPClient *http.Client) (*cosStore, error) {
	location, err := NormalizeLocation(raw)
	if err != nil {
		return nil, err
	}
	if location.Provider != ProviderCOS {
		return nil, errors.New("creation: COS adapter requires provider cos")
	}
	if strings.TrimSpace(credentials.AccessKeyID) == "" || strings.TrimSpace(credentials.SecretAccessKey) == "" {
		return nil, errors.New("creation: COS credentials are required")
	}
	bucketURL, err := cos.NewBucketURL(location.Bucket, location.Region, true)
	if err != nil || bucketURL.String() != location.Origin() {
		return nil, errors.New("creation: COS SDK rejected the canonical public location")
	}
	transport := http.DefaultTransport
	client := &http.Client{}
	if baseHTTPClient != nil {
		*client = *baseHTTPClient
		if baseHTTPClient.Transport != nil {
			transport = baseHTTPClient.Transport
		}
	}
	client.Transport = &cos.AuthorizationTransport{
		SecretID:  credentials.AccessKeyID,
		SecretKey: credentials.SecretAccessKey,
		Transport: transport,
	}
	return &cosStore{
		client:   cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, client),
		location: location,
	}, nil
}

func (s *cosStore) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (domain.PutResult, error) {
	return s.put(ctx, key, src, maxBytes, "", nil)
}

func (s *cosStore) putProviderTransfer(ctx context.Context, key string, src io.Reader, maxBytes int64, contentType string, metadata map[string]string) (domain.PutResult, error) {
	return s.put(ctx, key, src, maxBytes, contentType, metadata)
}

func (s *cosStore) put(ctx context.Context, key string, src io.Reader, maxBytes int64, contentType string, metadata map[string]string) (domain.PutResult, error) {
	result, err := streamBoundedPut(ctx, src, maxBytes, func(body io.Reader) error {
		headers := make(http.Header)
		headers.Set("x-cos-forbid-overwrite", "true")
		metadataHeaders := make(http.Header, len(metadata))
		for name, value := range metadata {
			metadataHeaders.Set("x-cos-meta-"+name, value)
		}
		options := &cos.ObjectPutOptions{ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
			ContentType: contentType,
			XCosMetaXXX: &metadataHeaders,
		}}
		putContext := context.WithValue(ctx, cos.XOptionalKey, &cos.XOptionalValue{Header: &headers})
		response, putErr := s.client.Object.Put(putContext, key, body, options)
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return safeCOSError("put", putErr)
	})
	if err != nil {
		return domain.PutResult{}, err
	}
	return result, nil
}

func (s *cosStore) presignGet(ctx context.Context, key string, expiresIn time.Duration) (string, error) {
	signedURL, err := s.client.Object.GetPresignedURL2(ctx, http.MethodGet, key, expiresIn, nil)
	if err != nil {
		return "", safeCOSError("presign get", err)
	}
	if err := validatePresignedOrigin(signedURL.String(), s.location.Origin()); err != nil {
		return "", err
	}
	return signedURL.String(), nil
}

func (s *cosStore) Head(ctx context.Context, key string) (domain.BlobInfo, error) {
	response, err := s.client.Object.Head(ctx, key, nil)
	if err != nil {
		return domain.BlobInfo{}, s.safeHeadError(ctx, key, err)
	}
	if response.Body != nil {
		response.Body.Close()
	}
	byteSize, err := strconv.ParseInt(response.Header.Get("Content-Length"), 10, 64)
	if err != nil {
		return domain.BlobInfo{}, fmt.Errorf("creation: COS head response: %w", domain.ErrObjectStorageUnavailable)
	}
	metadata := map[string]string{}
	for name, values := range response.Header {
		if metadataName, ok := strings.CutPrefix(strings.ToLower(name), "x-cos-meta-"); ok && len(values) > 0 {
			metadata[metadataName] = values[0]
		}
	}
	return domain.BlobInfo{
		ByteSize:    byteSize,
		ContentType: response.Header.Get("Content-Type"),
		Metadata:    metadata,
	}, nil
}

func (s *cosStore) safeHeadError(ctx context.Context, key string, headErr error) error {
	var responseErr *cos.ErrorResponse
	if !errors.As(headErr, &responseErr) || responseErr.Response == nil || responseErr.Response.StatusCode != http.StatusNotFound || responseErr.Code != "" {
		return safeCOSError("head", headErr)
	}

	// COS HEAD errors have no body, so an exact one-byte GET is required to
	// distinguish an absent object from an unavailable or absent bucket.
	response, getErr := s.client.Object.Get(ctx, key, &cos.ObjectGetOptions{Range: "bytes=0-0"})
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if getErr != nil {
		return safeCOSError("head", getErr)
	}
	return fmt.Errorf("creation: COS head inconsistent not-found response: %w", domain.ErrObjectStorageUnavailable)
}

func (s *cosStore) Open(ctx context.Context, key string, rng domain.BlobRange) (domain.ReadSeekCloser, int64, error) {
	info, err := s.Head(ctx, key)
	if err != nil {
		return nil, 0, err
	}
	window := newRemoteWindow(ctx, rng, info.ByteSize, func(ctx context.Context, start, stop int64) (io.ReadCloser, error) {
		response, getErr := s.client.Object.Get(ctx, key, &cos.ObjectGetOptions{
			Range: fmt.Sprintf("bytes=%d-%d", start, stop-1),
		})
		if getErr != nil {
			return nil, safeCOSError("open", getErr)
		}
		return response.Body, nil
	})
	return window, info.ByteSize, nil
}

func (s *cosStore) Delete(ctx context.Context, key string) error {
	response, err := s.client.Object.Delete(ctx, key)
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if mapped := safeCOSError("delete", err); errors.Is(mapped, domain.ErrBlobNotFound) {
		return nil
	} else {
		return mapped
	}
}

func (s *cosStore) PresignPut(ctx context.Context, request domain.PresignPutRequest) (domain.PresignedPut, error) {
	if err := validatePresignPutRequest(request); err != nil {
		return domain.PresignedPut{}, err
	}
	headers := make(http.Header)
	headers.Set("Content-Type", request.ContentType)
	headers.Set("x-cos-meta-"+domain.UploadIDMetadataKey, request.UploadID)
	headers.Set("x-cos-forbid-overwrite", "true")
	expiresAt := time.Now().Add(request.ExpiresIn)
	signedURL, err := s.client.Object.GetPresignedURL2(ctx, http.MethodPut, request.Key, request.ExpiresIn, &cos.PresignedURLOptions{Header: &headers})
	if err != nil {
		return domain.PresignedPut{}, safeCOSError("presign put", err)
	}
	if err := validatePresignedOrigin(signedURL.String(), s.location.Origin()); err != nil {
		return domain.PresignedPut{}, err
	}
	if !cosPresignCoversHeaders(signedURL, headers) {
		return domain.PresignedPut{}, fmt.Errorf("creation: COS presign headers: %w", domain.ErrObjectStorageUnavailable)
	}
	return domain.PresignedPut{
		Method: http.MethodPut,
		URL:    signedURL.String(),
		Headers: map[string]string{
			"Content-Type":           request.ContentType,
			"X-Cos-Meta-Upload-Id":   request.UploadID,
			"X-Cos-Forbid-Overwrite": "true",
		},
		ExpiresAt: expiresAt,
	}, nil
}

func cosPresignCoversHeaders(signedURL *url.URL, headers http.Header) bool {
	signed := make(map[string]struct{})
	for _, name := range strings.Split(signedURL.Query().Get("q-header-list"), ";") {
		signed[name] = struct{}{}
	}
	for name := range headers {
		if _, ok := signed[strings.ToLower(name)]; !ok {
			return false
		}
	}
	return true
}

func safeCOSError(operation string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("creation: COS %s canceled: %w", operation, err)
	}
	var responseErr *cos.ErrorResponse
	if errors.As(err, &responseErr) && responseErr.Response != nil {
		switch responseErr.Code {
		case "NoSuchKey":
			return fmt.Errorf("creation: COS %s: %w", operation, domain.ErrBlobNotFound)
		case "FileAlreadyExists":
			return fmt.Errorf("creation: COS %s: %w", operation, domain.ErrBlobConflict)
		}
	}
	return fmt.Errorf("creation: COS %s: %w", operation, domain.ErrObjectStorageUnavailable)
}
