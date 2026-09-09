package creationhttp

import (
	"net/http"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestObjectStorageMaintenanceErrorsHaveStablePublicCodes(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{domain.ErrObjectStorageConnectionNotConfigured, http.StatusNotFound, "object_storage_connection_not_configured"},
		{domain.ErrObjectStorageRevisionConflict, http.StatusConflict, "object_storage_connection_revision_conflict"},
		{domain.ErrObjectStorageLocationFrozen, http.StatusConflict, "object_storage_location_frozen"},
		{domain.ErrObjectStorageConnectionInUse, http.StatusConflict, "object_storage_connection_in_use"},
		{domain.ErrObjectStorageRecoveryRequired, http.StatusConflict, "object_storage_recovery_required"},
		{domain.ErrObjectStorageRecoveryNotRequired, http.StatusConflict, "object_storage_recovery_not_required"},
	}
	for _, test := range tests {
		mapped := MapError(test.err)
		if mapped == nil || mapped.Status != test.status || mapped.Code != test.code {
			t.Fatalf("MapError(%v) = %#v, want status=%d code=%q", test.err, mapped, test.status, test.code)
		}
	}
}
