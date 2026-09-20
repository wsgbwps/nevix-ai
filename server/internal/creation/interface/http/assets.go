package creationhttp

import (
	"encoding/hex"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type AssetHandler struct {
	assets  *application.AssetService
	storage *application.ObjectStorageConnectionService
}

func NewAssetHandler(assets *application.AssetService, storage *application.ObjectStorageConnectionService) *AssetHandler {
	return &AssetHandler{assets: assets, storage: storage}
}

func (h *AssetHandler) List(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := parsePageParams(w, r)
	if !ok {
		return
	}
	filter, ok := parseAssetFilter(w, r)
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	assets, next, err := h.assets.List(r.Context(), principal, filter, cursor, limit)
	if err != nil {
		fail(w, r, err)
		return
	}
	items := make([]assetResource, 0, len(assets))
	for _, asset := range assets {
		items = append(items, toAssetResource(asset))
	}
	encodeJSON(w, http.StatusOK, listAssetsResponse{Assets: items, NextCursor: cursorToken(next)})
}

func (h *AssetHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	detail, err := h.assets.Get(r.Context(), principal, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	siblings := make([]assetResource, 0, len(detail.Siblings))
	for _, sibling := range detail.Siblings {
		siblings = append(siblings, toAssetResource(sibling))
	}
	encodeJSON(w, http.StatusOK, assetDetailResponse{
		Asset: toAssetResource(detail.Asset), Siblings: siblings,
		PrivateOrigin: toPrivateOriginResource(detail.PrivateOrigin),
	})
}

func (h *AssetHandler) Download(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	asset, err := h.assets.Resolve(r.Context(), principal, id)
	if err != nil {
		fail(w, r, err)
		return
	}
	streamVerifiedBlob(w, r, h.storage, verifiedBlob{
		Key: asset.BlobKey, Mime: asset.Mime, Size: asset.ByteSize, Checksum: asset.Checksum,
	})
}

func (h *AssetHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "assetID")
	if !ok {
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	if err := h.assets.Delete(r.Context(), principal, id); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parseAssetFilter(w http.ResponseWriter, r *http.Request) (domain.AssetListFilter, bool) {
	query := r.URL.Query()
	filter := domain.AssetListFilter{
		Sort:   domain.AssetNewest,
		Search: strings.TrimSpace(query.Get("search")),
	}
	if utf8.RuneCountInString(filter.Search) > 200 {
		return invalidAssetFilter(w, "search must be at most 200 characters.")
	}
	if raw := query.Get("media_type"); raw != "" {
		media := domain.MediaType(raw)
		if media != domain.MediaImage && media != domain.MediaVideo {
			return invalidAssetFilter(w, "media_type must be image or video.")
		}
		filter.MediaType = &media
	}
	if raw := query.Get("created_since"); raw != "" {
		createdSince, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return invalidAssetFilter(w, "created_since must be an RFC3339 timestamp.")
		}
		filter.CreatedSince = &createdSince
	}
	if raw := query.Get("created_until"); raw != "" {
		createdUntil, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return invalidAssetFilter(w, "created_until must be an RFC3339 timestamp.")
		}
		filter.CreatedUntil = &createdUntil
	}
	if raw := query.Get("sort"); raw != "" {
		filter.Sort = domain.AssetSort(raw)
		if filter.Sort != domain.AssetNewest && filter.Sort != domain.AssetOldest {
			return invalidAssetFilter(w, "sort must be newest or oldest.")
		}
	}
	return filter, true
}

func invalidAssetFilter(w http.ResponseWriter, message string) (domain.AssetListFilter, bool) {
	WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: message})
	return domain.AssetListFilter{}, false
}

type listAssetsResponse struct {
	Assets     []assetResource `json:"assets"`
	NextCursor *string         `json:"next_cursor"`
}

type assetDetailResponse struct {
	Asset         assetResource          `json:"asset"`
	Siblings      []assetResource        `json:"siblings"`
	PrivateOrigin *privateOriginResource `json:"private_origin,omitempty"`
}

type assetResource struct {
	ID               string                    `json:"id"`
	Creator          assetCreatorResource      `json:"creator"`
	MediaType        string                    `json:"media_type"`
	MimeType         string                    `json:"mime_type"`
	ByteSize         int64                     `json:"byte_size"`
	Checksum         string                    `json:"checksum_sha256"`
	WidthPx          *int                      `json:"width_px"`
	HeightPx         *int                      `json:"height_px"`
	DurationMS       *int                      `json:"duration_ms"`
	CreatedAt        string                    `json:"created_at"`
	Restricted       bool                      `json:"restricted"`
	RestrictionState *string                   `json:"restriction_state"`
	Publication      *assetPublicationResource `json:"publication"`
	Capabilities     assetCapabilitiesResource `json:"capabilities"`
}

type assetPublicationResource struct {
	ID               string  `json:"id"`
	PublishedAt      string  `json:"published_at"`
	Restricted       bool    `json:"restricted"`
	RestrictionState *string `json:"restriction_state"`
}

type assetCreatorResource struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type assetCapabilitiesResource struct {
	CanDelete        bool `json:"can_delete"`
	CanCreateSimilar bool `json:"can_create_similar"`
	CanPublish       bool `json:"can_publish"`
	CanRestrict      bool `json:"can_restrict"`
	CanRelease       bool `json:"can_release"`
}

func toAssetResource(view application.AssetView) assetResource {
	asset := view.Asset
	checksum := ""
	if len(asset.Checksum) == 32 {
		checksum = hex.EncodeToString(asset.Checksum)
	}
	var publication *assetPublicationResource
	if asset.ActivePublication != nil {
		publication = &assetPublicationResource{
			ID:               asset.ActivePublication.ID.String(),
			PublishedAt:      asset.ActivePublication.PublishedAt.UTC().Format(time.RFC3339Nano),
			Restricted:       asset.ActivePublication.Restricted,
			RestrictionState: restrictionStateResource(asset.ActivePublication.RestrictionState),
		}
	}
	return assetResource{
		ID:        asset.ID.String(),
		Creator:   assetCreatorResource{ID: asset.OwnerID.String(), DisplayName: asset.CreatorDisplayName},
		MediaType: string(asset.MediaType), MimeType: asset.Mime, ByteSize: asset.ByteSize,
		Checksum: checksum, WidthPx: asset.WidthPx, HeightPx: asset.HeightPx,
		DurationMS: asset.DurationMS, CreatedAt: asset.CreatedAt.UTC().Format(time.RFC3339Nano),
		Restricted: asset.Restricted, RestrictionState: restrictionStateResource(asset.RestrictionState),
		Publication: publication,
		Capabilities: assetCapabilitiesResource{
			CanDelete: view.Capabilities.CanDelete, CanCreateSimilar: view.Capabilities.CanCreateSimilar,
			CanPublish: view.Capabilities.CanPublish, CanRestrict: view.Capabilities.CanRestrict,
			CanRelease: view.Capabilities.CanRelease,
		},
	}
}

func restrictionStateResource(state domain.RestrictionState) *string {
	if state == "" {
		return nil
	}
	value := string(state)
	return &value
}

type privateOriginResource struct {
	SessionID     string                          `json:"session_id"`
	SessionName   *string                         `json:"session_name,omitempty"`
	TaskID        string                          `json:"task_id"`
	SlotIndex     int                             `json:"slot_index"`
	Specification generationSpecificationResource `json:"specification"`
	References    []referenceSummaryResource      `json:"references"`
}

func toPrivateOriginResource(origin *domain.AssetPrivateOrigin) *privateOriginResource {
	if origin == nil {
		return nil
	}
	return &privateOriginResource{
		SessionID: origin.SessionID.String(), SessionName: origin.SessionName,
		TaskID: origin.TaskID.String(), SlotIndex: origin.SlotIndex,
		Specification: toGenerationSpecificationResource(origin.Spec),
		References:    toMaterialReferenceResources(origin.Spec, origin.References),
	}
}
