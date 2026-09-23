package creationhttp

import (
	"encoding/hex"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type PublicationHandler struct {
	publications *application.PublicationService
	storage      *application.ObjectStorageConnectionService
}

func NewPublicationHandler(publications *application.PublicationService, storage *application.ObjectStorageConnectionService) *PublicationHandler {
	return &PublicationHandler{publications: publications, storage: storage}
}

type idempotencyRequest struct {
	IdempotencyKey *string `json:"idempotency_key"`
}

type publicationResponse struct {
	Publication publicationResource `json:"publication"`
}

type assetRestrictionResponse struct {
	Asset assetResource `json:"asset"`
}

type publicationDetailResponse struct {
	Publication   publicationResource             `json:"publication"`
	Specification generationSpecificationResource `json:"specification"`
	References    []referenceSummaryResource      `json:"references"`
}

type adminAssetDetailResponse struct {
	Asset         assetResource                   `json:"asset"`
	Specification generationSpecificationResource `json:"specification"`
	References    []referenceSummaryResource      `json:"references"`
	Publication   *publicationResource            `json:"publication"`
}

type inspirationResponse struct {
	Items      []inspirationItemResource `json:"items"`
	NextCursor *string                   `json:"next_cursor"`
}

type inspirationItemResource struct {
	Type        string               `json:"type"`
	Asset       *assetResource       `json:"asset,omitempty"`
	Publication *publicationResource `json:"publication,omitempty"`
}

type publicationResource struct {
	ID               string                          `json:"id"`
	SourceAssetID    string                          `json:"source_asset_id"`
	Publisher        assetCreatorResource            `json:"publisher"`
	MediaType        string                          `json:"media_type"`
	MimeType         string                          `json:"mime_type"`
	ByteSize         int64                           `json:"byte_size"`
	Checksum         string                          `json:"checksum_sha256"`
	WidthPx          *int                            `json:"width_px"`
	HeightPx         *int                            `json:"height_px"`
	DurationMS       *int                            `json:"duration_ms"`
	PublishedAt      string                          `json:"published_at"`
	Restricted       bool                            `json:"restricted"`
	RestrictionState *string                         `json:"restriction_state"`
	Capabilities     publicationCapabilitiesResource `json:"capabilities"`
}

type publicationCapabilitiesResource struct {
	CanWithdraw      bool `json:"can_withdraw"`
	CanCreateSimilar bool `json:"can_create_similar"`
	CanRestrict      bool `json:"can_restrict"`
	CanRelease       bool `json:"can_release"`
}

type generationSpecificationResource struct {
	SchemaVersion   int                              `json:"schema_version"`
	MediaType       string                           `json:"media_type"`
	Prompt          string                           `json:"prompt"`
	Model           string                           `json:"model"`
	Mode            string                           `json:"mode"`
	ManifestVersion int                              `json:"manifest_version"`
	Ratio           *string                          `json:"ratio"`
	Resolution      *string                          `json:"resolution"`
	Quantity        int                              `json:"quantity"`
	DurationSeconds *int                             `json:"duration_seconds"`
	References      []specificationReferenceResource `json:"references"`
}

type specificationReferenceResource struct {
	MaterialID    string `json:"material_id"`
	Role          string `json:"role"`
	Kind          string `json:"kind"`
	ClaimsVersion int    `json:"claims_version"`
}

type referenceSummaryResource struct {
	ID            string `json:"id"`
	Role          string `json:"role"`
	Kind          string `json:"kind"`
	FileName      string `json:"file_name"`
	MimeType      string `json:"mime_type"`
	ByteSize      int64  `json:"byte_size"`
	WidthPx       *int   `json:"width_px"`
	HeightPx      *int   `json:"height_px"`
	DurationMS    *int   `json:"duration_ms"`
	ClaimsVersion int    `json:"claims_version"`
}

func (h *PublicationHandler) Publish(w http.ResponseWriter, r *http.Request) {
	assetID, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	var input idempotencyRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.IdempotencyKey == nil {
		invalidPublicationInput(w)
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	publication, created, err := h.publications.Publish(r.Context(), principal, assetID, strings.TrimSpace(*input.IdempotencyKey))
	if err != nil {
		fail(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	encodeJSON(w, status, publicationResponse{Publication: toPublicationResource(publication)})
}

func (h *PublicationHandler) ListInspiration(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := parsePageParams(w, r)
	if !ok {
		return
	}
	filter, ok := parseInspirationFilter(w, r)
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	items, next, err := h.publications.ListInspiration(r.Context(), principal, filter, cursor, limit)
	if err != nil {
		fail(w, r, err)
		return
	}
	resources := make([]inspirationItemResource, 0, len(items))
	for _, item := range items {
		resource := inspirationItemResource{Type: item.Type}
		if item.Asset != nil {
			asset := toAssetResource(*item.Asset)
			resource.Asset = &asset
		}
		if item.Publication != nil {
			publication := toPublicationResource(*item.Publication)
			resource.Publication = &publication
		}
		resources = append(resources, resource)
	}
	encodeJSON(w, http.StatusOK, inspirationResponse{Items: resources, NextCursor: cursorToken(next)})
}

func (h *PublicationHandler) GetPublication(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	detail, err := h.publications.GetPublication(r.Context(), principal, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, publicationDetailResponse{
		Publication:   toPublicationResource(detail.Publication),
		Specification: toGenerationSpecificationResource(detail.Publication.Publication.Specification),
		References:    toReferenceResources(detail.References),
	})
}

func (h *PublicationHandler) GetAdminAsset(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	detail, err := h.publications.GetAdminAsset(r.Context(), principal, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	response := adminAssetDetailResponse{
		Asset: toAssetResource(detail.Asset), Specification: toGenerationSpecificationResource(detail.Specification),
		References: toReferenceResources(detail.References),
	}
	if detail.Publication != nil {
		publication := toPublicationResource(*detail.Publication)
		response.Publication = &publication
	}
	encodeJSON(w, http.StatusOK, response)
}

func (h *PublicationHandler) DownloadPublication(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	publication, err := h.publications.ResolvePublication(r.Context(), principal, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	streamVerifiedBlob(w, r, h.storage, verifiedBlob{Key: publication.BlobKey, Mime: publication.Mime, Size: publication.ByteSize, Checksum: publication.Checksum})
}

func (h *PublicationHandler) DownloadAdminAsset(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	asset, err := h.publications.ResolveAdminAsset(r.Context(), principal, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	streamVerifiedBlob(w, r, h.storage, verifiedBlob{Key: asset.BlobKey, Mime: asset.Mime, Size: asset.ByteSize, Checksum: asset.Checksum})
}

func (h *PublicationHandler) PublicationReferencePreview(w http.ResponseWriter, r *http.Request) {
	publicationID, referenceID, ok := referencePathIDs(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	authorization, err := h.publications.AuthorizePublicationPreview(r.Context(), principal, publicationID, referenceID)
	writeDisplayAuthorization(w, r, authorization, err)
}

func (h *PublicationHandler) AdminAssetReferencePreview(w http.ResponseWriter, r *http.Request) {
	assetID, referenceID, ok := referencePathIDs(w, r, "assetID")
	if !ok {
		return
	}
	authorization, err := h.publications.AuthorizeAdminAssetPreview(r.Context(), assetID, referenceID)
	writeDisplayAuthorization(w, r, authorization, err)
}

// GetAdminAssetThumbnailURL and GetAdminAssetPreviewURL answer the Inspiration
// Page's wall and detail variants for the exact Asset an Admin selected. The
// Admin path admits an actively restricted Asset: governing a restriction
// requires seeing what is restricted.
func (h *PublicationHandler) GetAdminAssetThumbnailURL(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	authorization, err := h.publications.AuthorizeAdminAssetThumbnail(r.Context(), principal, id)
	writeDisplayAuthorization(w, r, authorization, err)
}

func (h *PublicationHandler) GetAdminAssetPreviewURL(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	authorization, err := h.publications.AuthorizeAdminAssetMediaPreview(r.Context(), principal, id)
	writeDisplayAuthorization(w, r, authorization, err)
}

// The same two variants for an effective Team Publication, which any active
// User may see.
func (h *PublicationHandler) GetPublicationThumbnailURL(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	authorization, err := h.publications.AuthorizePublicationThumbnail(r.Context(), principal, id)
	writeDisplayAuthorization(w, r, authorization, err)
}

func (h *PublicationHandler) GetPublicationPreviewURL(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	authorization, err := h.publications.AuthorizePublicationMediaPreview(r.Context(), principal, id)
	writeDisplayAuthorization(w, r, authorization, err)
}

func (h *PublicationHandler) Withdraw(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	if err := h.publications.Withdraw(r.Context(), principal, id); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *PublicationHandler) RestrictAsset(w http.ResponseWriter, r *http.Request) {
	h.setAssetRestriction(w, r, true)
}

func (h *PublicationHandler) ReleaseAsset(w http.ResponseWriter, r *http.Request) {
	h.setAssetRestriction(w, r, false)
}

func (h *PublicationHandler) setAssetRestriction(w http.ResponseWriter, r *http.Request, active bool) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	var asset application.AssetView
	var err error
	if active {
		asset, err = h.publications.RestrictAsset(r.Context(), principal, id)
	} else {
		asset, err = h.publications.ReleaseAsset(r.Context(), principal, id)
	}
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, assetRestrictionResponse{Asset: toAssetResource(asset)})
}

func (h *PublicationHandler) RestrictPublication(w http.ResponseWriter, r *http.Request) {
	h.setPublicationRestriction(w, r, true)
}

func (h *PublicationHandler) ReleasePublication(w http.ResponseWriter, r *http.Request) {
	h.setPublicationRestriction(w, r, false)
}

func (h *PublicationHandler) setPublicationRestriction(w http.ResponseWriter, r *http.Request, active bool) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	var publication application.PublicationView
	var err error
	if active {
		publication, err = h.publications.RestrictPublication(r.Context(), principal, id)
	} else {
		publication, err = h.publications.ReleasePublication(r.Context(), principal, id)
	}
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, publicationResponse{Publication: toPublicationResource(publication)})
}

type createSimilarResponse struct {
	Session           sessionResource                 `json:"session"`
	Materials         []similarMaterialResource       `json:"materials"`
	Specification     generationSpecificationResource `json:"specification"`
	SubmissionBlocked bool                            `json:"submission_blocked"`
}

type similarMaterialResource struct {
	SessionID string `json:"session_id"`
	materialResource
}

func (h *PublicationHandler) CreateSimilar(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "publicationID")
	if !ok {
		return
	}
	var input idempotencyRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.IdempotencyKey == nil {
		invalidPublicationInput(w)
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	result, created, err := h.publications.CreateSimilar(r.Context(), principal, id, strings.TrimSpace(*input.IdempotencyKey))
	if err != nil {
		fail(w, r, err)
		return
	}
	materials := make([]similarMaterialResource, 0, len(result.Materials))
	for _, material := range result.Materials {
		materials = append(materials, similarMaterialResource{SessionID: material.SessionID.String(), materialResource: toMaterialResource(material)})
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	encodeJSON(w, status, createSimilarResponse{
		Session: toSessionResource(result.Session), Materials: materials,
		Specification:     toGenerationSpecificationResource(result.Specification),
		SubmissionBlocked: result.SubmissionBlocked,
	})
}

func parseInspirationFilter(w http.ResponseWriter, r *http.Request) (domain.AssetListFilter, bool) {
	filter, ok := parseAssetFilter(w, r)
	if !ok {
		return domain.AssetListFilter{}, false
	}
	filter.Creator = strings.TrimSpace(r.URL.Query().Get("creator"))
	if utf8.RuneCountInString(filter.Creator) > 128 {
		return invalidAssetFilter(w, "creator must be at most 128 characters.")
	}
	return filter, true
}

func toPublicationResource(view application.PublicationView) publicationResource {
	publication := view.Publication
	checksum := ""
	if len(publication.Checksum) == 32 {
		checksum = hex.EncodeToString(publication.Checksum)
	}
	return publicationResource{
		ID: publication.ID.String(), SourceAssetID: publication.SourceAssetID.String(),
		Publisher: assetCreatorResource{ID: publication.PublisherID.String(), DisplayName: publication.PublisherDisplayName},
		MediaType: string(publication.MediaType), MimeType: publication.Mime, ByteSize: publication.ByteSize,
		Checksum: checksum, WidthPx: publication.WidthPx, HeightPx: publication.HeightPx,
		DurationMS: publication.DurationMS, PublishedAt: publication.PublishedAt.UTC().Format(timeRFC3339),
		Restricted: publication.Restricted, RestrictionState: restrictionStateResource(publication.RestrictionState),
		Capabilities: publicationCapabilitiesResource{
			CanWithdraw: view.Capabilities.CanWithdraw, CanCreateSimilar: view.Capabilities.CanCreateSimilar,
			CanRestrict: view.Capabilities.CanRestrict, CanRelease: view.Capabilities.CanRelease,
		},
	}
}

func toGenerationSpecificationResource(spec domain.GenerationSpecification) generationSpecificationResource {
	references := make([]specificationReferenceResource, 0, len(spec.References))
	for _, reference := range spec.References {
		references = append(references, specificationReferenceResource{
			MaterialID: reference.MaterialID.String(), Role: string(reference.Role),
			Kind: string(reference.Kind), ClaimsVersion: reference.ClaimsVersion,
		})
	}
	return generationSpecificationResource{
		SchemaVersion: spec.SchemaVersion, MediaType: string(spec.MediaType), Prompt: spec.Prompt,
		Model: spec.Model, Mode: spec.Mode, ManifestVersion: spec.ManifestVersion,
		Ratio: spec.Ratio, Resolution: spec.Resolution, Quantity: spec.Quantity,
		DurationSeconds: spec.DurationSeconds, References: references,
	}
}

func toReferenceResources(references []domain.PublicationReference) []referenceSummaryResource {
	resources := make([]referenceSummaryResource, 0, len(references))
	for _, reference := range references {
		resources = append(resources, referenceSummaryResource{
			ID: reference.ID.String(), Role: string(reference.Role), Kind: string(reference.Kind),
			FileName: reference.FileName, MimeType: reference.MimeType, ByteSize: reference.ByteSize,
			WidthPx: reference.WidthPx, HeightPx: reference.HeightPx, DurationMS: reference.DurationMS,
			ClaimsVersion: reference.ClaimsVersion,
		})
	}
	return resources
}

func toMaterialReferenceResources(spec domain.GenerationSpecification, materials []domain.ReferenceMaterial) []referenceSummaryResource {
	byID := make(map[domain.UUID]domain.ReferenceMaterial, len(materials))
	for _, material := range materials {
		byID[material.ID] = material
	}
	resources := make([]referenceSummaryResource, 0, len(spec.References))
	for _, frozen := range spec.References {
		material, ok := byID[frozen.MaterialID]
		if !ok {
			continue
		}
		resources = append(resources, referenceSummaryResource{
			ID: material.ID.String(), Role: string(frozen.Role), Kind: string(material.Kind),
			FileName: material.FileName, MimeType: material.MimeType, ByteSize: material.ByteSize,
			WidthPx: material.WidthPx, HeightPx: material.HeightPx, DurationMS: material.DurationMS,
			ClaimsVersion: material.ClaimsVersion,
		})
	}
	return resources
}

func referencePathIDs(w http.ResponseWriter, r *http.Request, parent string) (domain.UUID, domain.UUID, bool) {
	parentID, ok := pathUUID(w, r, parent)
	if !ok {
		return domain.UUID{}, domain.UUID{}, false
	}
	referenceID, ok := pathUUID(w, r, "referenceID")
	return parentID, referenceID, ok
}

func writeDisplayAuthorization(w http.ResponseWriter, r *http.Request, authorization application.DisplayURLAuthorization, err error) {
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, displayURLResponse{URL: authorization.URL, ExpiresAt: authorization.ExpiresAt.Format(timeRFC3339)})
}

func invalidPublicationInput(w http.ResponseWriter) {
	WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "A valid idempotency_key is required."})
}
