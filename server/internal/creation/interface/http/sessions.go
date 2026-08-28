package creationhttp

import (
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// Page defaults and bounds mirrored from contracts/creation.yaml.
const (
	defaultPageLimit = 50
	maxPageLimit     = 200
)

// SessionHandler owns the session routes.
type SessionHandler struct {
	sessions *application.SessionService
}

func NewSessionHandler(sessions *application.SessionService) *SessionHandler {
	return &SessionHandler{sessions: sessions}
}

// sessionResource is the wire shape of a session.
type sessionResource struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func toSessionResource(s domain.Session) sessionResource {
	return sessionResource{
		ID:        s.ID.String(),
		Name:      s.Name,
		CreatedAt: s.CreatedAt.UTC().Format(timeRFC3339),
		UpdatedAt: s.UpdatedAt.UTC().Format(timeRFC3339),
	}
}

const timeRFC3339 = "2006-01-02T15:04:05Z07:00"

type createSessionRequest struct {
	Name *string `json:"name"`
}

// CreateSession answers POST /creation/sessions with 201 and the resource.
func (h *SessionHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	name := ""
	if req.Name != nil {
		name = *req.Name
	}
	session, err := h.sessions.Create(r.Context(), creatorID(w, r), name)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusCreated, toSessionResource(session))
}

// ListSessions answers GET /creation/sessions.
func (h *SessionHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := parsePageParams(w, r)
	if !ok {
		return
	}
	page, next, err := h.sessions.List(r.Context(), creatorID(w, r), cursor, limit)
	if err != nil {
		fail(w, r, err)
		return
	}
	items := make([]sessionResource, 0, len(page))
	for _, session := range page {
		items = append(items, toSessionResource(session))
	}
	encodeJSON(w, http.StatusOK, listSessionsResponse{Sessions: items, NextCursor: cursorToken(next)})
}

type listSessionsResponse struct {
	Sessions   []sessionResource `json:"sessions"`
	NextCursor *string           `json:"next_cursor"`
}

// GetSession answers GET /creation/sessions/{sessionID} with the session and
// its recoverable draft (null when never saved).
func (h *SessionHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	session, draft, err := h.sessions.GetWithDraft(r.Context(), creatorID(w, r), id)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, sessionDetailResource{
		sessionResource: toSessionResource(session),
		Draft:           toDraftResource(draft),
	})
}

// sessionDetailResource is the getSession wire shape: the session plus its
// recoverable draft.
type sessionDetailResource struct {
	sessionResource
	Draft *draftResource `json:"draft"`
}

// draftResource is the wire shape of one stored draft.
type draftResource struct {
	Prompt          string                   `json:"prompt"`
	MediaType       *string                  `json:"media_type"`
	ManifestVersion int                      `json:"manifest_version"`
	Model           *string                  `json:"model"`
	Mode            *string                  `json:"mode"`
	Ratio           *string                  `json:"ratio"`
	Resolution      *string                  `json:"resolution"`
	Quantity        *int                     `json:"quantity"`
	DurationSeconds *int                     `json:"duration_seconds"`
	References      []draftReferenceResource `json:"references"`
}

type draftReferenceResource struct {
	MaterialID string `json:"material_id"`
	Role       string `json:"role"`
}

func toDraftResource(draft *domain.SessionDraft) *draftResource {
	if draft == nil {
		return nil
	}
	resource := &draftResource{
		Prompt:          draft.Prompt,
		ManifestVersion: draft.ManifestVersion,
		References:      make([]draftReferenceResource, 0, len(draft.References)),
	}
	if draft.MediaType != nil {
		media := string(*draft.MediaType)
		resource.MediaType = &media
	}
	resource.Model, resource.Mode, resource.Ratio, resource.Resolution = draft.Model, draft.Mode, draft.Ratio, draft.Resolution
	resource.Quantity, resource.DurationSeconds = draft.Quantity, draft.DurationSeconds
	for _, reference := range draft.References {
		resource.References = append(resource.References, draftReferenceResource{
			MaterialID: reference.MaterialID.String(),
			Role:       string(reference.Role),
		})
	}
	return resource
}

type saveDraftRequest struct {
	Prompt          *string                  `json:"prompt"`
	MediaType       *string                  `json:"media_type"`
	ManifestVersion int                      `json:"manifest_version"`
	Model           *string                  `json:"model"`
	Mode            *string                  `json:"mode"`
	Ratio           *string                  `json:"ratio"`
	Resolution      *string                  `json:"resolution"`
	Quantity        *int                     `json:"quantity"`
	DurationSeconds *int                     `json:"duration_seconds"`
	References      []draftReferenceResource `json:"references"`
}

// SaveDraft answers PUT /creation/sessions/{sessionID}/draft with the stored
// draft. The references field is required per contract; a missing field is
// rejected exactly like any other envelope violation.
func (h *SessionHandler) SaveDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	var req saveDraftRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.References == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The references field is required."})
		return
	}
	draft := &domain.SessionDraft{
		ManifestVersion: req.ManifestVersion,
		References:      make([]domain.DraftReference, 0, len(req.References)),
	}
	if req.Prompt != nil {
		draft.Prompt = *req.Prompt
	}
	if req.MediaType != nil {
		media := domain.DraftMediaType(*req.MediaType)
		draft.MediaType = &media
	}
	draft.Model, draft.Mode, draft.Ratio, draft.Resolution = req.Model, req.Mode, req.Ratio, req.Resolution
	draft.Quantity, draft.DurationSeconds = req.Quantity, req.DurationSeconds
	for _, reference := range req.References {
		materialID, err := domain.ParseUUID(reference.MaterialID)
		if err != nil {
			WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Every reference must carry a material_id uuid."})
			return
		}
		draft.References = append(draft.References, domain.DraftReference{
			MaterialID: materialID,
			Role:       domain.DraftRole(reference.Role),
		})
	}
	if err := h.sessions.SaveDraft(r.Context(), creatorID(w, r), id, draft); err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toDraftResource(draft))
}

type renameSessionRequest struct {
	Name *string `json:"name"`
}

// RenameSession answers PATCH /creation/sessions/{sessionID}; the name field
// is required per contract.
func (h *SessionHandler) RenameSession(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	var req renameSessionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The name field is required."})
		return
	}
	session, err := h.sessions.Rename(r.Context(), creatorID(w, r), id, *req.Name)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toSessionResource(session))
}

// DeleteSession answers DELETE /creation/sessions/{sessionID} with 204; a
// repeated delete observes the same 404 as any other post-delete access.
func (h *SessionHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	if err := h.sessions.Delete(r.Context(), creatorID(w, r), id); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// MaterialHandler owns the material routes under the same ownership rules.
type MaterialHandler struct {
	materials *application.MaterialService
}

func NewMaterialHandler(materials *application.MaterialService) *MaterialHandler {
	return &MaterialHandler{materials: materials}
}

// materialResource is the wire shape of a reference material.
type materialResource struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	FileName       string `json:"file_name"`
	MimeType       string `json:"mime_type"`
	ByteSize       int64  `json:"byte_size"`
	WidthPx        *int   `json:"width_px"`
	HeightPx       *int   `json:"height_px"`
	PixelCount     *int64 `json:"pixel_count"`
	DurationMS     *int   `json:"duration_ms"`
	ChecksumSHA256 string `json:"checksum_sha256"`
	ClaimsVersion  int    `json:"claims_version"`
	CreatedAt      string `json:"created_at"`
}

func toMaterialResource(m domain.ReferenceMaterial) materialResource {
	checksum := ""
	if len(m.ChecksumSHA256) == 32 {
		checksum = hex.EncodeToString(m.ChecksumSHA256)
	}
	return materialResource{
		ID:             m.ID.String(),
		Kind:           string(m.Kind),
		FileName:       m.FileName,
		MimeType:       m.MimeType,
		ByteSize:       m.ByteSize,
		WidthPx:        m.WidthPx,
		HeightPx:       m.HeightPx,
		PixelCount:     m.PixelCount,
		DurationMS:     m.DurationMS,
		ChecksumSHA256: checksum,
		ClaimsVersion:  m.ClaimsVersion,
		CreatedAt:      m.CreatedAt.UTC().Format(timeRFC3339),
	}
}

type listMaterialsResponse struct {
	Materials  []materialResource `json:"materials"`
	NextCursor *string            `json:"next_cursor"`
}

// ListMaterials answers GET /creation/sessions/{sessionID}/materials.
func (h *MaterialHandler) ListMaterials(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	limit, cursor, ok := parsePageParams(w, r)
	if !ok {
		return
	}
	page, next, err := h.materials.List(r.Context(), creatorID(w, r), sessionID, cursor, limit)
	if err != nil {
		fail(w, r, err)
		return
	}
	items := make([]materialResource, 0, len(page))
	for _, material := range page {
		items = append(items, toMaterialResource(material))
	}
	encodeJSON(w, http.StatusOK, listMaterialsResponse{Materials: items, NextCursor: cursorToken(next)})
}

// DeleteMaterial answers DELETE /creation/materials/{materialID} with 204.
func (h *MaterialHandler) DeleteMaterial(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "materialID")
	if !ok {
		return
	}
	if err := h.materials.Delete(r.Context(), creatorID(w, r), id); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- shared helpers -------------------------------------------------------

// creatorID extracts the authenticated principal's user id; the guard has
// already proven it resolves, so a parse failure here is a wiring fault.
func creatorID(w http.ResponseWriter, r *http.Request) domain.UUID {
	principal, _ := authz.PrincipalFrom(r.Context())
	id, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		WriteError(w, &Error{Status: http.StatusInternalServerError, Code: CodeInternalError, Message: "The request could not be completed."})
		return domain.UUID{}
	}
	return id
}

// pathUUID parses one chi URL parameter. A malformed id answers exactly like
// an absent or foreign one (404 not_found) so format probing learns nothing —
// the Identity Module precedent for every scoped target.
func pathUUID(w http.ResponseWriter, r *http.Request, name string) (domain.UUID, bool) {
	raw := chi.URLParam(r, name)
	id, err := domain.ParseUUID(raw)
	if err != nil {
		WriteError(w, &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "The requested resource was not found."})
		return domain.UUID{}, false
	}
	return id, true
}

// parsePageParams reads limit/cursor per contract bounds.
func parsePageParams(w http.ResponseWriter, r *http.Request) (int, *domain.CompoundCursor, bool) {
	limit := defaultPageLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxPageLimit {
			WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "limit must be between 1 and 200."})
			return 0, nil, false
		}
		limit = parsed
	}
	var cursor *domain.CompoundCursor
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		decoded, err := domain.DecodeCursor(raw)
		if err != nil {
			WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidCursor, Message: "cursor is not a valid token."})
			return 0, nil, false
		}
		cursor = &decoded
	}
	return limit, cursor, true
}

// cursorToken renders the continuation pointer or JSON null.
func cursorToken(next *domain.CompoundCursor) *string {
	if next == nil {
		return nil
	}
	token := domain.EncodeCursor(*next)
	return &token
}
