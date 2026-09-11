package integrationtest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

type fakeUploadGrant struct {
	request creation.PresignPutRequest
	headers map[string]string
}

type fakeDirectUploadStore struct {
	mu                  sync.Mutex
	provider            creation.ObjectStorageProvider
	objects             map[string][]byte
	generatedObjects    map[string]generatedObject
	info                map[string]creation.BlobInfo
	grants              map[string]fakeUploadGrant
	nextGrant           int64
	server              *httptest.Server
	headError           error
	headStarted         chan struct{}
	releaseHead         chan struct{}
	openReadError       error
	openError           error
	sequentialReadError error
	putStarted          chan struct{}
	releasePut          chan struct{}
	conflictAfterPut    bool
	deleteFailures      int
	deleteFailureKeys   map[string]struct{}
	deleteBlockingKeys  map[string]struct{}
	deletedKeys         []string
	maxGeneratedRead    int
}

type generatedObject struct {
	size int64
	fill byte
}

func newFakeDirectUploadStore(t *testing.T) *fakeDirectUploadStore {
	t.Helper()
	store := &fakeDirectUploadStore{
		provider:           creation.ObjectStorageProviderOSS,
		objects:            map[string][]byte{},
		generatedObjects:   map[string]generatedObject{},
		info:               map[string]creation.BlobInfo{},
		grants:             map[string]fakeUploadGrant{},
		deleteFailureKeys:  map[string]struct{}{},
		deleteBlockingKeys: map[string]struct{}{},
	}
	store.server = httptest.NewServer(http.HandlerFunc(store.serveUpload))
	t.Cleanup(store.server.Close)
	return store
}

func (s *fakeDirectUploadStore) replaceWithGeneratedObject(key string, size int64, fill byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generatedObjects[key] = generatedObject{size: size, fill: fill}
	info := s.info[key]
	info.ByteSize = size
	s.info[key] = info
}

func (s *fakeDirectUploadStore) largestGeneratedRead() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.maxGeneratedRead
}

func (s *fakeDirectUploadStore) setProvider(provider creation.ObjectStorageProvider) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.provider = provider
}

func (s *fakeDirectUploadStore) replaceUploadMetadata(rawURL, uploadID string) {
	token := strings.TrimPrefix(rawURL, s.server.URL+"/")
	s.mu.Lock()
	defer s.mu.Unlock()
	grant, ok := s.grants[token]
	if !ok {
		return
	}
	info := s.info[grant.request.Key]
	info.Metadata[creation.UploadIDMetadataKey] = uploadID
	s.info[grant.request.Key] = info
}

func (s *fakeDirectUploadStore) blockNextHead() (<-chan struct{}, chan<- struct{}) {
	started := make(chan struct{})
	release := make(chan struct{})
	s.mu.Lock()
	s.headStarted = started
	s.releaseHead = release
	s.mu.Unlock()
	return started, release
}

func (s *fakeDirectUploadStore) failNextHead(err error) {
	s.mu.Lock()
	s.headError = err
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) failNextProbeRead(err error) {
	s.mu.Lock()
	s.openReadError = err
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) failNextReferenceOpen(err error) {
	s.mu.Lock()
	s.openError = err
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) failNextReferenceRead(err error) {
	s.mu.Lock()
	s.sequentialReadError = err
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) blockNextPut() (<-chan struct{}, chan<- struct{}) {
	started := make(chan struct{})
	release := make(chan struct{})
	s.mu.Lock()
	s.putStarted = started
	s.releasePut = release
	s.mu.Unlock()
	return started, release
}

func (s *fakeDirectUploadStore) conflictAfterNextPut() {
	s.mu.Lock()
	s.conflictAfterPut = true
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) failDeletes(count int) {
	s.mu.Lock()
	s.deleteFailures = count
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) failDeleteFor(key string) {
	s.mu.Lock()
	s.deleteFailureKeys[key] = struct{}{}
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) blockDeleteFor(key string) {
	s.mu.Lock()
	s.deleteBlockingKeys[key] = struct{}{}
	s.mu.Unlock()
}

func (s *fakeDirectUploadStore) cleanupKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.deletedKeys...)
}

func (s *fakeDirectUploadStore) serveUpload(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.URL.Path, "/")
	s.mu.Lock()
	grant, ok := s.grants[token]
	_, exists := s.objects[grant.request.Key]
	s.mu.Unlock()
	if !ok || r.Method != http.MethodPut {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if exists {
		http.Error(w, "conflict", http.StatusConflict)
		return
	}
	for name, want := range grant.headers {
		if got := r.Header.Get(name); got != want {
			http.Error(w, "signed header mismatch", http.StatusForbidden)
			return
		}
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	metadataHeader := "X-Oss-Meta-Upload-Id"
	if _, ok := grant.headers["X-Cos-Meta-Upload-Id"]; ok {
		metadataHeader = "X-Cos-Meta-Upload-Id"
	}
	s.mu.Lock()
	s.objects[grant.request.Key] = append([]byte(nil), body...)
	s.info[grant.request.Key] = creation.BlobInfo{
		ByteSize:    int64(len(body)),
		ContentType: r.Header.Get("Content-Type"),
		Metadata: map[string]string{
			creation.UploadIDMetadataKey: r.Header.Get(metadataHeader),
		},
	}
	s.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (s *fakeDirectUploadStore) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (creation.PutResult, error) {
	if err := ctx.Err(); err != nil {
		return creation.PutResult{}, err
	}
	body, err := io.ReadAll(io.LimitReader(src, maxBytes+1))
	if err != nil {
		return creation.PutResult{}, err
	}
	if int64(len(body)) > maxBytes {
		return creation.PutResult{}, creation.ErrTooLarge
	}
	s.mu.Lock()
	started, release := s.putStarted, s.releasePut
	s.putStarted, s.releasePut = nil, nil
	conflictAfterPut := s.conflictAfterPut
	s.conflictAfterPut = false
	s.mu.Unlock()
	if started != nil {
		close(started)
		select {
		case <-ctx.Done():
			return creation.PutResult{}, ctx.Err()
		case <-release:
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.objects[key]; exists {
		return creation.PutResult{}, creation.ErrBlobConflict
	}
	s.objects[key] = append([]byte(nil), body...)
	s.info[key] = creation.BlobInfo{ByteSize: int64(len(body)), Metadata: map[string]string{}}
	if conflictAfterPut {
		return creation.PutResult{}, creation.ErrBlobConflict
	}
	return creation.PutResult{ByteSize: int64(len(body)), SHA256Sum: sha256.Sum256(body)}, nil
}

func (s *fakeDirectUploadStore) Head(ctx context.Context, key string) (creation.BlobInfo, error) {
	if err := ctx.Err(); err != nil {
		return creation.BlobInfo{}, err
	}
	s.mu.Lock()
	if s.headError != nil {
		err := s.headError
		s.headError = nil
		s.mu.Unlock()
		return creation.BlobInfo{}, err
	}
	started, release := s.headStarted, s.releaseHead
	s.headStarted, s.releaseHead = nil, nil
	s.mu.Unlock()
	if started != nil {
		close(started)
		select {
		case <-ctx.Done():
			return creation.BlobInfo{}, ctx.Err()
		case <-release:
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, ok := s.info[key]
	if !ok {
		return creation.BlobInfo{}, creation.ErrBlobNotFound
	}
	return info, nil
}

func (s *fakeDirectUploadStore) Open(ctx context.Context, key string, rng creation.BlobRange) (creation.ReadSeekCloser, int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	s.mu.Lock()
	if s.openError != nil {
		err := s.openError
		s.openError = nil
		s.mu.Unlock()
		return nil, 0, err
	}
	body, ok := s.objects[key]
	generated, generatedOK := s.generatedObjects[key]
	copyOfBody := append([]byte(nil), body...)
	readError := s.openReadError
	s.openReadError = nil
	sequentialReadError := s.sequentialReadError
	s.sequentialReadError = nil
	s.mu.Unlock()
	if generatedOK {
		start := rng.Offset
		stop := generated.size
		if rng.Length >= 0 && start+rng.Length < stop {
			stop = start + rng.Length
		}
		if start < 0 || start > generated.size || stop < start {
			return nil, 0, creation.ErrRangeNotSatisfiable
		}
		return &generatedReadSeekCloser{
			size: stop - start,
			fill: generated.fill,
			observe: func(size int) {
				s.mu.Lock()
				defer s.mu.Unlock()
				if size > s.maxGeneratedRead {
					s.maxGeneratedRead = size
				}
			},
		}, generated.size, nil
	}
	if !ok {
		return nil, 0, creation.ErrBlobNotFound
	}
	start := rng.Offset
	stop := int64(len(copyOfBody))
	if rng.Length >= 0 && start+rng.Length < stop {
		stop = start + rng.Length
	}
	if start < 0 || start > int64(len(copyOfBody)) || stop < start {
		return nil, 0, creation.ErrRangeNotSatisfiable
	}
	reader := bytes.NewReader(copyOfBody[start:stop])
	if sequentialReadError != nil {
		return &readSeekFailure{reader: reader, err: sequentialReadError}, int64(len(copyOfBody)), nil
	}
	if readError != nil {
		return &failReadAfterSeek{reader: reader, err: readError}, int64(len(copyOfBody)), nil
	}
	return readSeekNopCloser{Reader: reader}, int64(len(copyOfBody)), nil
}

func (s *fakeDirectUploadStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	s.deletedKeys = append(s.deletedKeys, key)
	_, blocked := s.deleteBlockingKeys[key]
	if _, failed := s.deleteFailureKeys[key]; failed {
		s.mu.Unlock()
		return errors.New("injected exact delete failure")
	}
	if s.deleteFailures > 0 {
		s.deleteFailures--
		s.mu.Unlock()
		return errors.New("injected exact delete failure")
	}
	if blocked {
		s.mu.Unlock()
		<-ctx.Done()
		return ctx.Err()
	}
	delete(s.objects, key)
	delete(s.generatedObjects, key)
	delete(s.info, key)
	s.mu.Unlock()
	return nil
}

type generatedReadSeekCloser struct {
	size     int64
	position int64
	fill     byte
	observe  func(int)
}

func (r *generatedReadSeekCloser) Read(buffer []byte) (int, error) {
	if r.position >= r.size {
		return 0, io.EOF
	}
	remaining := r.size - r.position
	if int64(len(buffer)) > remaining {
		buffer = buffer[:remaining]
	}
	for index := range buffer {
		buffer[index] = r.fill
	}
	r.position += int64(len(buffer))
	r.observe(len(buffer))
	return len(buffer), nil
}

func (r *generatedReadSeekCloser) Seek(offset int64, whence int) (int64, error) {
	next := offset
	switch whence {
	case io.SeekCurrent:
		next = r.position + offset
	case io.SeekEnd:
		next = r.size + offset
	case io.SeekStart:
	default:
		return 0, errors.New("invalid seek origin")
	}
	if next < 0 {
		return 0, errors.New("negative seek position")
	}
	r.position = next
	return next, nil
}

func (*generatedReadSeekCloser) Close() error { return nil }

func (s *fakeDirectUploadStore) PresignPut(ctx context.Context, request creation.PresignPutRequest) (creation.PresignedPut, error) {
	if err := ctx.Err(); err != nil {
		return creation.PresignedPut{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	metadataHeader := "X-Oss-Meta-Upload-Id"
	forbidHeader := "X-Oss-Forbid-Overwrite"
	if s.provider == creation.ObjectStorageProviderCOS {
		metadataHeader = "X-Cos-Meta-Upload-Id"
		forbidHeader = "X-Cos-Forbid-Overwrite"
	}
	headers := map[string]string{
		"Content-Type": request.ContentType,
		metadataHeader: request.UploadID,
		forbidHeader:   "true",
	}
	s.nextGrant++
	token := strconv.FormatInt(s.nextGrant, 10)
	s.grants[token] = fakeUploadGrant{request: request, headers: headers}
	return creation.PresignedPut{
		Method:    http.MethodPut,
		URL:       s.server.URL + "/" + token,
		Headers:   headers,
		ExpiresAt: time.Now().UTC().Add(request.ExpiresIn),
	}, nil
}

type readSeekNopCloser struct{ *bytes.Reader }

func (readSeekNopCloser) Close() error { return nil }

type readSeekFailure struct {
	reader *bytes.Reader
	err    error
	read   bool
}

func (r *readSeekFailure) Read(p []byte) (int, error) {
	if r.read {
		return 0, r.err
	}
	r.read = true
	if len(p) > 8 {
		p = p[:8]
	}
	return r.reader.Read(p)
}

func (r *readSeekFailure) Seek(offset int64, whence int) (int64, error) {
	return r.reader.Seek(offset, whence)
}

func (*readSeekFailure) Close() error { return nil }

type failReadAfterSeek struct {
	reader *bytes.Reader
	err    error
	fail   bool
}

func (r *failReadAfterSeek) Read(p []byte) (int, error) {
	if r.fail {
		return 0, r.err
	}
	return r.reader.Read(p)
}

func (r *failReadAfterSeek) Seek(offset int64, whence int) (int64, error) {
	position, err := r.reader.Seek(offset, whence)
	if err == nil && position == 0 {
		r.fail = true
	}
	return position, err
}

func (*failReadAfterSeek) Close() error { return nil }
