package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"

	"github.com/nevix-ai/server/internal/creation/domain"
)

const copyBufferLen = 256 << 10

func drainPutError(ch chan error) {
	for range ch {
	}
}

// pumpInto copies under one fixed buffer, enforcing the caller's byte ceiling
// before a provider can commit an oversized single-object upload.
func pumpInto(ctx context.Context, src io.Reader, dst *io.PipeWriter, maxBytes int64, hasher hash.Hash) (domain.PutResult, error) {
	buffer := make([]byte, copyBufferLen)
	var written int64
	fail := func(err error) (domain.PutResult, error) {
		dst.CloseWithError(err)
		return domain.PutResult{}, fmt.Errorf("%w: %w", errPumpFailed, err)
	}
	for {
		select {
		case <-ctx.Done():
			return fail(fmt.Errorf("blob upload canceled: %w", ctx.Err()))
		default:
		}
		n, readErr := src.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			total := written + int64(n)
			if total > maxBytes {
				dst.CloseWithError(domain.ErrTooLarge)
				return domain.PutResult{}, fmt.Errorf("%w: more than %d bytes", domain.ErrTooLarge, maxBytes)
			}
			hasher.Write(chunk)
			if _, writeErr := dst.Write(chunk); writeErr != nil {
				return fail(writeErr)
			}
			written = total
		}
		if readErr == io.EOF {
			dst.Close()
			var sum [32]byte
			copy(sum[:], hasher.Sum(nil))
			return domain.PutResult{ByteSize: written, SHA256Sum: sum}, nil
		}
		if readErr != nil {
			if ctx.Err() != nil || errors.Is(readErr, context.Canceled) {
				return fail(fmt.Errorf("blob upload canceled: %w", readErr))
			}
			return fail(&sourceReadError{err: readErr})
		}
	}
}

var errPumpFailed = errors.New("pump failed")

type sourceReadError struct{ err error }

func (e *sourceReadError) Error() string { return "source read failed" }

func (e *sourceReadError) Unwrap() error { return e.err }

func streamBoundedPut(ctx context.Context, src io.Reader, maxBytes int64, upload func(io.Reader) error) (domain.PutResult, error) {
	pipeReader, pipeWriter := io.Pipe()
	uploadErr := make(chan error, 1)
	go func() {
		defer close(uploadErr)
		err := upload(pipeReader)
		if err != nil {
			pipeReader.CloseWithError(err)
		}
		uploadErr <- err
	}()

	result, copyErr := pumpInto(ctx, src, pipeWriter, maxBytes, sha256.New())
	var providerErr error
	switch {
	case copyErr != nil && errors.Is(copyErr, errPumpFailed):
		providerErr = <-uploadErr
	case copyErr != nil:
		go drainPutError(uploadErr)
	default:
		providerErr = <-uploadErr
	}
	if copyErr != nil && errors.Is(copyErr, domain.ErrTooLarge) {
		return domain.PutResult{}, copyErr
	}
	if copyErr != nil || providerErr != nil {
		return domain.PutResult{}, errors.Join(copyErr, providerErr)
	}
	return result, nil
}
