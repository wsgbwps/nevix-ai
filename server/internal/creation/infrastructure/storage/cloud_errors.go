package storage

import (
	"net/http"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func classifyCloudServiceStatus(status int) error {
	switch {
	case status == http.StatusTooManyRequests:
		return domain.ErrObjectStorageRateLimited
	case status == http.StatusRequestTimeout || status >= http.StatusInternalServerError && status <= 599:
		return domain.ErrObjectStorageUnavailable
	default:
		return domain.ErrObjectStorageConfiguration
	}
}
