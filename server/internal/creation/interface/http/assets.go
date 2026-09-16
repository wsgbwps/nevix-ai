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

const maxAssetCreatorLength = 128

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
		Creator: strings.TrimSpace(query.Get("creator")),
		Sort:    domain.AssetNewest,
		Search:  strings.TrimSpace(query.Get("search")),
	}
	if utf8.RuneCountInString(filter.Creator) > maxAssetCreatorLength {
		return invalidAssetFilter(w, "creator must be at most 128 characters.")
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
	ID           string                    `json:"id"`
	Creator      assetCreatorResource      `json:"creator"`
	MediaType    string                    `json:"media_type"`
	MimeType     string                    `json:"mime_type"`
	ByteSize     int64                     `json:"byte_size"`
	Checksum     string                    `json:"checksum_sha256"`
	WidthPx      *int                      `json:"width_px"`
	HeightPx     *int                      `json:"height_px"`
	DurationMS   *int                      `json:"duration_ms"`
	CreatedAt    string                    `json:"created_at"`
	Capabilities assetCapabilitiesResource `json:"capabilities"`
}

type assetCreatorResource struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type assetCapabilitiesResource struct {
	CanDelete        bool `json:"can_delete"`
	CanCreateSimilar bool `json:"can_create_similar"`
}

func toAssetResource(view application.AssetView) assetResource {
	asset := view.Asset
	checksum := ""
	if len(asset.Checksum) == 32 {
		checksum = hex.EncodeToString(asset.Checksum)
	}
	return assetResource{
		ID:        asset.ID.String(),
		Creator:   assetCreatorResource{ID: asset.OwnerID.String(), DisplayName: asset.CreatorDisplayName},
		MediaType: string(asset.MediaType), MimeType: asset.Mime, ByteSize: asset.ByteSize,
		Checksum: checksum, WidthPx: asset.WidthPx, HeightPx: asset.HeightPx,
		DurationMS: asset.DurationMS, CreatedAt: asset.CreatedAt.UTC().Format(time.RFC3339Nano),
		Capabilities: assetCapabilitiesResource{
			CanDelete: view.Capabilities.CanDelete, CanCreateSimilar: view.Capabilities.CanCreateSimilar,
		},
	}
}

type privateOriginResource struct {
	SessionID     string              `json:"session_id"`
	SessionName   *string             `json:"session_name,omitempty"`
	TaskID        string              `json:"task_id"`
	SlotIndex     int                 `json:"slot_index"`
	Specification privateSpecResource `json:"specification"`
}

type privateSpecResource struct {
	Prompt          string  `json:"prompt"`
	MediaType       string  `json:"media_type"`
	Model           string  `json:"model"`
	Mode            string  `json:"mode"`
	ManifestVersion int     `json:"manifest_version"`
	Ratio           *string `json:"ratio"`
	Resolution      *string `json:"resolution"`
	Quantity        int     `json:"quantity"`
	DurationSeconds *int    `json:"duration_seconds"`
}

func toPrivateOriginResource(origin *domain.AssetPrivateOrigin) *privateOriginResource {
	if origin == nil {
		return nil
	}
	return &privateOriginResource{
		SessionID: origin.SessionID.String(), SessionName: origin.SessionName,
		TaskID: origin.TaskID.String(), SlotIndex: origin.SlotIndex,
		Specification: privateSpecResource{
			Prompt: origin.Spec.Prompt, MediaType: string(origin.Spec.MediaType),
			Model: origin.Spec.Model, Mode: origin.Spec.Mode, ManifestVersion: origin.Spec.ManifestVersion,
			Ratio: origin.Spec.Ratio, Resolution: origin.Spec.Resolution, Quantity: origin.Spec.Quantity,
			DurationSeconds: origin.Spec.DurationSeconds,
		},
	}
}
