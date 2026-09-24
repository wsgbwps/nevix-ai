package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type TeamPublicationRepository struct{ pool querySource }

func NewTeamPublicationRepository(pool *pgxpool.Pool) *TeamPublicationRepository {
	return &TeamPublicationRepository{pool: pool}
}

const publicationColumns = `p.id, p.source_asset_id, p.publisher_user_id,
	p.publisher_display_name, p.media_type, p.mime, p.blob_key, p.byte_size,
	p.checksum, p.width_px, p.height_px, p.duration_ms, p.specification, p.published_at,
	p.direct_restricted_at IS NOT NULL AND p.direct_restriction_released_at IS NULL,
	CASE
		WHEN p.direct_restricted_at IS NOT NULL AND p.direct_restriction_released_at IS NULL THEN 'active'
		WHEN p.restricted_at IS NOT NULL THEN 'released'
		ELSE ''
	END,
	CASE
		WHEN p.direct_restricted_at IS NULL THEN ''
		WHEN p.direct_restriction_released_at IS NULL THEN 'active'
		ELSE 'released'
	END`

func (r *TeamPublicationRepository) Publish(ctx context.Context, tx domain.TxExecutor, publisher, assetID domain.UUID, key string) (domain.TeamPublication, bool, error) {
	var asset domain.MediaAsset
	var media string
	var specJSON []byte
	err := tx.QueryRow(ctx, `
		SELECT a.id, a.owner_user_id, u.display_name, a.task_id, a.slot_index,
		       a.media_type, a.mime, a.blob_key, a.byte_size, a.checksum,
		       a.width_px, a.height_px, a.duration_ms, a.created_at, t.specification
		FROM creation_media_assets a
		JOIN users u ON u.id = a.owner_user_id
		JOIN creation_generation_tasks t ON t.id = a.task_id
		WHERE a.id = $1 AND a.owner_user_id = $2
		  AND a.deleted_at IS NULL
		  AND (a.restricted_at IS NULL OR a.restriction_released_at IS NOT NULL)
		FOR UPDATE OF a`, assetID, publisher).Scan(
		&asset.ID, &asset.OwnerID, &asset.CreatorDisplayName, &asset.TaskID, &asset.SlotIndex,
		&media, &asset.Mime, &asset.BlobKey, &asset.ByteSize, &asset.Checksum,
		&asset.WidthPx, &asset.HeightPx, &asset.DurationMS, &asset.CreatedAt, &specJSON,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TeamPublication{}, false, domain.ErrAssetNotFound
	}
	if err != nil {
		return domain.TeamPublication{}, false, fmt.Errorf("creation: lock asset for publication: %w", err)
	}
	asset.MediaType = domain.MediaType(media)

	if current, err := scanPublication(tx.QueryRow(ctx, `SELECT `+publicationColumns+`
		FROM creation_team_publications p
		WHERE p.source_asset_id = $1 AND p.withdrawn_at IS NULL AND p.restricted_at IS NULL`, assetID)); err == nil {
		return current, false, nil
	} else if !errors.Is(err, domain.ErrPublicationNotFound) {
		return domain.TeamPublication{}, false, err
	}
	var restrictionActive bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM creation_team_publications
			WHERE source_asset_id = $1 AND withdrawn_at IS NULL
			  AND direct_restricted_at IS NOT NULL
			  AND direct_restriction_released_at IS NULL
		)`, assetID).Scan(&restrictionActive); err != nil {
		return domain.TeamPublication{}, false, fmt.Errorf("creation: check publication restriction: %w", err)
	}
	if restrictionActive {
		return domain.TeamPublication{}, false, domain.ErrAssetNotFound
	}

	var spec domain.GenerationSpecification
	if err := json.Unmarshal(specJSON, &spec); err != nil {
		return domain.TeamPublication{}, false, fmt.Errorf("creation: decode asset publication specification: %w", err)
	}
	snapshotSpec := spec
	snapshotSpec.References = append([]domain.SpecificationReference(nil), spec.References...)
	snapshotReferences := make([]domain.PublicationReference, 0, len(spec.References))
	for position, reference := range spec.References {
		var material domain.ReferenceMaterial
		var kind string
		err := tx.QueryRow(ctx, `
			SELECT m.id, m.session_id, m.kind, m.file_name, m.mime_type, m.byte_size,
			       m.checksum_sha256, m.blob_key, m.width_px, m.height_px, m.pixel_count,
			       m.duration_ms, m.claims_version, m.created_at
			FROM creation_reference_materials m
			JOIN creation_generation_task_references retained ON retained.material_id = m.id
			WHERE retained.task_id = $1 AND m.id = $2`, asset.TaskID, reference.MaterialID).Scan(
			&material.ID, &material.SessionID, &kind, &material.FileName, &material.MimeType,
			&material.ByteSize, &material.ChecksumSHA256, &material.BlobKey, &material.WidthPx,
			&material.HeightPx, &material.PixelCount, &material.DurationMS, &material.ClaimsVersion,
			&material.CreatedAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.TeamPublication{}, false, domain.ErrAssetReferenceUnavailable
		}
		if err != nil {
			return domain.TeamPublication{}, false, fmt.Errorf("creation: load publication reference: %w", err)
		}
		referenceID := domain.NewUUID()
		snapshotSpec.References[position].MaterialID = referenceID
		snapshotReferences = append(snapshotReferences, domain.PublicationReference{
			ID: referenceID, Position: position, Role: reference.Role, Kind: domain.Kind(kind),
			FileName: material.FileName, MimeType: material.MimeType, ByteSize: material.ByteSize,
			ChecksumSHA256: material.ChecksumSHA256, BlobKey: material.BlobKey,
			WidthPx: material.WidthPx, HeightPx: material.HeightPx, PixelCount: material.PixelCount,
			DurationMS: material.DurationMS, ClaimsVersion: material.ClaimsVersion,
		})
	}
	snapshotSpecJSON, err := json.Marshal(snapshotSpec)
	if err != nil {
		return domain.TeamPublication{}, false, err
	}
	publication := domain.TeamPublication{
		ID: domain.NewUUID(), SourceAssetID: asset.ID, PublisherID: publisher,
		PublisherDisplayName: asset.CreatorDisplayName, MediaType: asset.MediaType,
		Mime: asset.Mime, ByteSize: asset.ByteSize, Checksum: asset.Checksum, BlobKey: asset.BlobKey,
		WidthPx: asset.WidthPx, HeightPx: asset.HeightPx, DurationMS: asset.DurationMS,
		Specification: snapshotSpec,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO creation_team_publications (
			id, source_asset_id, publisher_user_id, publisher_display_name, idempotency_key,
			media_type, mime, blob_key, byte_size, checksum, width_px, height_px,
			duration_ms, specification
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (publisher_user_id, idempotency_key) DO NOTHING
		RETURNING published_at`,
		publication.ID, publication.SourceAssetID, publication.PublisherID,
		publication.PublisherDisplayName, key, publication.MediaType, publication.Mime,
		publication.BlobKey, publication.ByteSize, publication.Checksum, publication.WidthPx,
		publication.HeightPx, publication.DurationMS, snapshotSpecJSON).Scan(&publication.PublishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		replay, replayErr := scanPublication(tx.QueryRow(ctx, `SELECT `+publicationColumns+`
			FROM creation_team_publications p
			WHERE p.publisher_user_id = $1 AND p.idempotency_key = $2
			  AND p.source_asset_id = $3 AND p.withdrawn_at IS NULL AND p.restricted_at IS NULL`, publisher, key, assetID))
		if replayErr != nil {
			return domain.TeamPublication{}, false, domain.ErrIdempotencyPayloadConflict
		}
		return replay, false, nil
	}
	if err != nil {
		return domain.TeamPublication{}, false, fmt.Errorf("creation: insert team publication: %w", err)
	}
	for _, reference := range snapshotReferences {
		if _, err := tx.Exec(ctx, `
			INSERT INTO creation_team_publication_references (
				id, publication_id, position, role, kind, file_name, mime_type, byte_size,
				checksum_sha256, blob_key, width_px, height_px, pixel_count, duration_ms, claims_version
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
			reference.ID, publication.ID, reference.Position, reference.Role, reference.Kind,
			reference.FileName, reference.MimeType, reference.ByteSize, reference.ChecksumSHA256,
			reference.BlobKey, reference.WidthPx, reference.HeightPx, reference.PixelCount,
			reference.DurationMS, reference.ClaimsVersion); err != nil {
			return domain.TeamPublication{}, false, fmt.Errorf("creation: snapshot publication reference: %w", err)
		}
	}
	return publication, true, nil
}

func (r *TeamPublicationRepository) ListInspiration(ctx context.Context, admin bool, filter domain.AssetListFilter, cursor *domain.CompoundCursor, limit int) ([]domain.InspirationItem, *domain.CompoundCursor, error) {
	items := make([]domain.InspirationItem, 0, limit*2)
	if admin {
		assets, err := r.listAdminAssets(ctx, filter, cursor, limit+1)
		if err != nil {
			return nil, nil, err
		}
		for index := range assets {
			asset := assets[index]
			items = append(items, domain.InspirationItem{Type: "asset", Asset: &asset})
		}
	}
	publications, err := r.listPublications(ctx, filter, cursor, limit+1, admin)
	if err != nil {
		return nil, nil, err
	}
	for index := range publications {
		publication := publications[index]
		items = append(items, domain.InspirationItem{Type: "publication", Publication: &publication})
	}
	sort.Slice(items, func(i, j int) bool {
		leftAt, leftID := inspirationSortKey(items[i])
		rightAt, rightID := inspirationSortKey(items[j])
		if leftAt.Equal(rightAt) {
			if filter.Sort == domain.AssetOldest {
				return leftID.String() < rightID.String()
			}
			return leftID.String() > rightID.String()
		}
		if filter.Sort == domain.AssetOldest {
			return leftAt.Before(rightAt)
		}
		return leftAt.After(rightAt)
	})
	var next *domain.CompoundCursor
	if len(items) > limit {
		at, id := inspirationSortKey(items[limit-1])
		next = &domain.CompoundCursor{CreatedAt: at, ID: id}
		items = items[:limit]
	}
	return items, next, nil
}

func inspirationSortKey(item domain.InspirationItem) (time.Time, domain.UUID) {
	if item.Asset != nil {
		return item.Asset.CreatedAt, item.Asset.ID
	}
	return item.Publication.PublishedAt, item.Publication.ID
}

func (r *TeamPublicationRepository) listAdminAssets(ctx context.Context, filter domain.AssetListFilter, cursor *domain.CompoundCursor, limit int) ([]domain.MediaAsset, error) {
	args := []any{}
	conditions := []string{"a.deleted_at IS NULL"}
	add := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	applyAssetFilter(&conditions, add, filter, "a.created_at", "a.id", "u.display_name")
	applyCursor(&conditions, add, filter.Sort, cursor, "a.created_at", "a.id")
	args = append(args, limit)
	direction := sortDirection(filter.Sort)
	rows, err := r.pool.Query(ctx, `SELECT `+assetColumns+assetFrom+`
		WHERE `+strings.Join(conditions, " AND ")+`
		ORDER BY a.created_at `+direction+`, a.id `+direction+`
		LIMIT `+fmt.Sprintf("$%d", len(args)), args...)
	if err != nil {
		return nil, fmt.Errorf("creation: list admin inspiration assets: %w", err)
	}
	defer rows.Close()
	assets := make([]domain.MediaAsset, 0, limit)
	for rows.Next() {
		asset, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		assets = append(assets, asset)
	}
	return assets, rows.Err()
}

func (r *TeamPublicationRepository) listPublications(ctx context.Context, filter domain.AssetListFilter, cursor *domain.CompoundCursor, limit int, deletedSourceOnly bool) ([]domain.TeamPublication, error) {
	args := []any{}
	conditions := []string{"p.withdrawn_at IS NULL"}
	if deletedSourceOnly {
		conditions = append(conditions,
			"a.deleted_at IS NOT NULL",
			"(p.restricted_at IS NULL OR (p.direct_restricted_at IS NOT NULL AND p.direct_restriction_released_at IS NULL))",
		)
	} else {
		conditions = append(conditions, "p.restricted_at IS NULL", "(a.restricted_at IS NULL OR a.restriction_released_at IS NOT NULL)")
	}
	add := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	applyPublicationFilter(&conditions, add, filter)
	applyCursor(&conditions, add, filter.Sort, cursor, "p.published_at", "p.id")
	args = append(args, limit)
	direction := sortDirection(filter.Sort)
	rows, err := r.pool.Query(ctx, `SELECT `+publicationColumns+`
		FROM creation_team_publications p
		JOIN creation_media_assets a ON a.id = p.source_asset_id
		WHERE `+strings.Join(conditions, " AND ")+`
		ORDER BY p.published_at `+direction+`, p.id `+direction+`
		LIMIT `+fmt.Sprintf("$%d", len(args)), args...)
	if err != nil {
		return nil, fmt.Errorf("creation: list inspiration publications: %w", err)
	}
	defer rows.Close()
	publications := make([]domain.TeamPublication, 0, limit)
	for rows.Next() {
		publication, err := scanPublication(rows)
		if err != nil {
			return nil, err
		}
		publications = append(publications, publication)
	}
	return publications, rows.Err()
}

func applyAssetFilter(conditions *[]string, add func(any) string, filter domain.AssetListFilter, createdColumn, idColumn, creatorColumn string) {
	if filter.MediaType != nil {
		*conditions = append(*conditions, "a.media_type = "+add(*filter.MediaType))
	}
	if filter.CreatedSince != nil {
		*conditions = append(*conditions, createdColumn+" >= "+add(filter.CreatedSince.UTC()))
	}
	if creator := strings.TrimSpace(filter.Creator); creator != "" {
		*conditions = append(*conditions, "lower("+creatorColumn+") LIKE "+add(escapeLike(strings.ToLower(creator))+"%")+` ESCAPE '\'`)
	}
	if search := strings.TrimSpace(filter.Search); search != "" {
		if id, err := domain.ParseUUID(search); err == nil {
			*conditions = append(*conditions, idColumn+" = "+add(id))
		} else {
			*conditions = append(*conditions, "lower("+creatorColumn+") LIKE "+add(escapeLike(strings.ToLower(search))+"%")+` ESCAPE '\'`)
		}
	}
}

func applyPublicationFilter(conditions *[]string, add func(any) string, filter domain.AssetListFilter) {
	if filter.MediaType != nil {
		*conditions = append(*conditions, "p.media_type = "+add(*filter.MediaType))
	}
	if filter.CreatedSince != nil {
		*conditions = append(*conditions, "p.published_at >= "+add(filter.CreatedSince.UTC()))
	}
	if creator := strings.TrimSpace(filter.Creator); creator != "" {
		*conditions = append(*conditions, "lower(p.publisher_display_name) LIKE "+add(escapeLike(strings.ToLower(creator))+"%")+` ESCAPE '\'`)
	}
	if search := strings.TrimSpace(filter.Search); search != "" {
		if id, err := domain.ParseUUID(search); err == nil {
			placeholder := add(id)
			*conditions = append(*conditions, "(p.id = "+placeholder+" OR p.source_asset_id = "+placeholder+")")
		} else {
			*conditions = append(*conditions, "lower(p.publisher_display_name) LIKE "+add(escapeLike(strings.ToLower(search))+"%")+` ESCAPE '\'`)
		}
	}
}

func applyCursor(conditions *[]string, add func(any) string, order domain.AssetSort, cursor *domain.CompoundCursor, atColumn, idColumn string) {
	if cursor == nil {
		return
	}
	comparison := "<"
	if order == domain.AssetOldest {
		comparison = ">"
	}
	*conditions = append(*conditions, fmt.Sprintf("(%s, %s) %s (%s, %s)", atColumn, idColumn, comparison, add(cursor.CreatedAt.UTC()), add(cursor.ID)))
}

func sortDirection(order domain.AssetSort) string {
	if order == domain.AssetOldest {
		return "ASC"
	}
	return "DESC"
}

func (r *TeamPublicationRepository) GetPublication(ctx context.Context, id domain.UUID, admin bool) (domain.PublicationDetail, error) {
	publication, err := scanPublication(r.pool.QueryRow(ctx, `SELECT `+publicationColumns+`
		FROM creation_team_publications p
		JOIN creation_media_assets a ON a.id = p.source_asset_id
		WHERE p.id = $1 AND p.withdrawn_at IS NULL
		  AND (($2 AND p.direct_restricted_at IS NOT NULL
		          AND p.direct_restriction_released_at IS NULL)
		    OR (p.restricted_at IS NULL
		      AND (a.restricted_at IS NULL OR a.restriction_released_at IS NOT NULL)))`, id, admin))
	if err != nil {
		return domain.PublicationDetail{}, err
	}
	references, err := r.listPublicationReferences(ctx, r.pool, id)
	return domain.PublicationDetail{Publication: publication, References: references}, err
}

func (r *TeamPublicationRepository) GetAdminAsset(ctx context.Context, id domain.UUID) (domain.AdminAssetDetail, error) {
	var detail domain.AdminAssetDetail
	var media string
	var specJSON []byte
	var publicationID *string
	var publicationRestricted *bool
	var assetRestrictionState string
	var publicationRestrictionState *string
	err := r.pool.QueryRow(ctx, `
		SELECT a.id, a.owner_user_id, u.display_name, a.task_id, a.slot_index,
		       a.media_type, a.mime, a.blob_key, a.byte_size, a.checksum,
		       a.width_px, a.height_px, a.duration_ms, a.created_at,
		       a.restricted_at IS NOT NULL AND a.restriction_released_at IS NULL,
		       CASE
		         WHEN a.restricted_at IS NULL THEN ''
		         WHEN a.restriction_released_at IS NULL THEN 'active'
		         ELSE 'released'
		       END,
		       p.id::text, p.restricted, p.restriction_state,
		       t.specification
		FROM creation_media_assets a
		JOIN users u ON u.id = a.owner_user_id
		JOIN creation_generation_tasks t ON t.id = a.task_id
		LEFT JOIN LATERAL (
			SELECT publication.id,
				CASE
				  WHEN (a.restricted_at IS NOT NULL AND a.restriction_released_at IS NULL)
				    OR (publication.direct_restricted_at IS NOT NULL AND publication.direct_restriction_released_at IS NULL)
				  THEN true ELSE false
				END AS restricted,
				CASE
				  WHEN (a.restricted_at IS NOT NULL AND a.restriction_released_at IS NULL)
				    OR (publication.direct_restricted_at IS NOT NULL AND publication.direct_restriction_released_at IS NULL)
				  THEN 'active'
				  WHEN publication.restricted_at IS NOT NULL THEN 'released'
				  ELSE ''
				END AS restriction_state
			FROM creation_team_publications publication
			WHERE publication.source_asset_id = a.id AND publication.withdrawn_at IS NULL
			ORDER BY (publication.restricted_at IS NULL) DESC,
				publication.published_at DESC, publication.id DESC
			LIMIT 1
		) p ON TRUE
		WHERE a.id = $1 AND a.deleted_at IS NULL`, id).Scan(
		&detail.Asset.ID, &detail.Asset.OwnerID, &detail.Asset.CreatorDisplayName,
		&detail.Asset.TaskID, &detail.Asset.SlotIndex, &media, &detail.Asset.Mime,
		&detail.Asset.BlobKey, &detail.Asset.ByteSize, &detail.Asset.Checksum,
		&detail.Asset.WidthPx, &detail.Asset.HeightPx, &detail.Asset.DurationMS,
		&detail.Asset.CreatedAt, &detail.Asset.Restricted, &assetRestrictionState,
		&publicationID, &publicationRestricted, &publicationRestrictionState, &specJSON,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.AdminAssetDetail{}, domain.ErrAssetNotFound
	}
	if err != nil {
		return domain.AdminAssetDetail{}, fmt.Errorf("creation: get admin inspiration asset: %w", err)
	}
	detail.Asset.MediaType = domain.MediaType(media)
	detail.Asset.RestrictionState = domain.RestrictionState(assetRestrictionState)
	if err := json.Unmarshal(specJSON, &detail.Specification); err != nil {
		return domain.AdminAssetDetail{}, fmt.Errorf("creation: decode admin asset specification: %w", err)
	}
	detail.References, err = r.listAdminAssetReferences(ctx, detail.Asset.TaskID, detail.Specification)
	if err != nil {
		return domain.AdminAssetDetail{}, err
	}
	if publicationID != nil {
		id, parseErr := domain.ParseUUID(*publicationID)
		if parseErr != nil {
			return domain.AdminAssetDetail{}, parseErr
		}
		publication, publicationErr := scanPublication(r.pool.QueryRow(ctx, `SELECT `+publicationColumns+`
			FROM creation_team_publications p WHERE p.id = $1`, id))
		if publicationErr != nil {
			return domain.AdminAssetDetail{}, publicationErr
		}
		publication.Restricted = publication.Restricted ||
			(publicationRestricted != nil && *publicationRestricted)
		if publicationRestrictionState != nil {
			publication.RestrictionState = domain.RestrictionState(*publicationRestrictionState)
		}
		detail.ActivePublication = &publication
		detail.Asset.ActivePublication = &publication
	}
	return detail, nil
}

func (r *TeamPublicationRepository) GetAdminAssetMedia(ctx context.Context, id domain.UUID) (domain.MediaAsset, error) {
	asset, err := scanAsset(r.pool.QueryRow(ctx, `SELECT `+assetColumns+assetFrom+`
		WHERE a.id = $1 AND a.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.MediaAsset{}, domain.ErrAssetNotFound
	}
	if err != nil {
		return domain.MediaAsset{}, fmt.Errorf("creation: get admin inspiration asset media: %w", err)
	}
	return asset, nil
}

func (r *TeamPublicationRepository) listAdminAssetReferences(ctx context.Context, taskID domain.UUID, spec domain.GenerationSpecification) ([]domain.PublicationReference, error) {
	references := make([]domain.PublicationReference, 0, len(spec.References))
	for position, frozen := range spec.References {
		var reference domain.PublicationReference
		var kind string
		err := r.pool.QueryRow(ctx, `
			SELECT m.id, m.kind, m.file_name, m.mime_type, m.byte_size, m.checksum_sha256,
			       m.blob_key, m.width_px, m.height_px, m.pixel_count, m.duration_ms, m.claims_version
			FROM creation_reference_materials m
			JOIN creation_generation_task_references retained ON retained.material_id = m.id
			WHERE retained.task_id = $1 AND m.id = $2`, taskID, frozen.MaterialID).Scan(
			&reference.ID, &kind, &reference.FileName, &reference.MimeType, &reference.ByteSize,
			&reference.ChecksumSHA256, &reference.BlobKey, &reference.WidthPx, &reference.HeightPx,
			&reference.PixelCount, &reference.DurationMS, &reference.ClaimsVersion,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("creation: load admin asset reference: %w", err)
		}
		reference.Position, reference.Role, reference.Kind = position, frozen.Role, domain.Kind(kind)
		references = append(references, reference)
	}
	return references, nil
}

func (r *TeamPublicationRepository) Withdraw(ctx context.Context, tx domain.TxExecutor, actor, id domain.UUID, admin bool) error {
	var assetID domain.UUID
	if err := tx.QueryRow(ctx, `SELECT source_asset_id FROM creation_team_publications WHERE id = $1`, id).Scan(&assetID); errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrPublicationNotFound
	} else if err != nil {
		return fmt.Errorf("creation: resolve publication asset for withdrawal: %w", err)
	}
	var locked domain.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM creation_media_assets WHERE id = $1 FOR UPDATE`, assetID).Scan(&locked); err != nil {
		return fmt.Errorf("creation: lock publication asset for withdrawal: %w", err)
	}
	query := `UPDATE creation_team_publications p SET withdrawn_at = clock_timestamp()
		WHERE p.id = $1 AND p.withdrawn_at IS NULL`
	args := []any{id}
	if !admin {
		query += " AND p.publisher_user_id = $2"
		args = append(args, actor)
	}
	query += " RETURNING p.id"
	var updated domain.UUID
	if err := tx.QueryRow(ctx, query, args...).Scan(&updated); errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrPublicationNotFound
	} else if err != nil {
		return fmt.Errorf("creation: withdraw team publication: %w", err)
	}
	return nil
}

func (r *TeamPublicationRepository) CreateSimilar(ctx context.Context, tx domain.TxExecutor, actor, id domain.UUID, key string) (domain.SimilarCreation, bool, error) {
	if replay, publicationID, err := loadSimilarOperation(ctx, tx, actor, key); err == nil {
		if publicationID != id {
			return domain.SimilarCreation{}, false, domain.ErrIdempotencyPayloadConflict
		}
		return replay, false, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return domain.SimilarCreation{}, false, err
	}
	detail, err := r.lockPublication(ctx, tx, id)
	if err != nil {
		return domain.SimilarCreation{}, false, err
	}
	if replay, publicationID, err := loadSimilarOperation(ctx, tx, actor, key); err == nil {
		if publicationID != id {
			return domain.SimilarCreation{}, false, domain.ErrIdempotencyPayloadConflict
		}
		return replay, false, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return domain.SimilarCreation{}, false, err
	}
	result := domain.SimilarCreation{Specification: detail.Publication.Specification}
	result.Session.ID = domain.NewUUID()
	result.Session.OwnerID = actor
	if err := tx.QueryRow(ctx, `
		INSERT INTO creation_sessions (id, owner_user_id, name) VALUES ($1, $2, '')
		RETURNING name, created_at, updated_at`, result.Session.ID, actor).Scan(
		&result.Session.Name, &result.Session.CreatedAt, &result.Session.UpdatedAt); err != nil {
		return domain.SimilarCreation{}, false, fmt.Errorf("creation: create similar session: %w", err)
	}
	result.Materials = make([]domain.ReferenceMaterial, 0, len(detail.References))
	for index, reference := range detail.References {
		material := domain.ReferenceMaterial{
			ID: domain.NewUUID(), SessionID: result.Session.ID, Kind: reference.Kind,
			FileName: reference.FileName, MimeType: reference.MimeType, ByteSize: reference.ByteSize,
			ChecksumSHA256: reference.ChecksumSHA256, BlobKey: reference.BlobKey,
			WidthPx: reference.WidthPx, HeightPx: reference.HeightPx, PixelCount: reference.PixelCount,
			DurationMS: reference.DurationMS, ClaimsVersion: reference.ClaimsVersion,
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO creation_reference_materials (
				id, session_id, kind, file_name, mime_type, byte_size, checksum_sha256,
				blob_key, width_px, height_px, pixel_count, duration_ms, claims_version
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
			RETURNING created_at`, material.ID, material.SessionID, material.Kind,
			material.FileName, material.MimeType, material.ByteSize, material.ChecksumSHA256,
			material.BlobKey, material.WidthPx, material.HeightPx, material.PixelCount,
			material.DurationMS, material.ClaimsVersion).Scan(&material.CreatedAt); err != nil {
			return domain.SimilarCreation{}, false, fmt.Errorf("creation: alias publication reference: %w", err)
		}
		result.Materials = append(result.Materials, material)
		result.Specification.References[index].MaterialID = material.ID
	}
	specJSON, err := json.Marshal(result.Specification)
	if err != nil {
		return domain.SimilarCreation{}, false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_publication_similar_operations
			(owner_user_id, publication_id, idempotency_key, session_id, specification)
		VALUES ($1,$2,$3,$4,$5)`, actor, id, key, result.Session.ID, specJSON); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return domain.SimilarCreation{}, false, domain.ErrIdempotencyPayloadConflict
		}
		return domain.SimilarCreation{}, false, fmt.Errorf("creation: record similar operation: %w", err)
	}
	return result, true, nil
}

func (r *TeamPublicationRepository) lockPublication(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (domain.PublicationDetail, error) {
	var assetID domain.UUID
	if err := tx.QueryRow(ctx, `SELECT source_asset_id FROM creation_team_publications WHERE id = $1`, id).Scan(&assetID); errors.Is(err, pgx.ErrNoRows) {
		return domain.PublicationDetail{}, domain.ErrPublicationNotFound
	} else if err != nil {
		return domain.PublicationDetail{}, fmt.Errorf("creation: resolve publication asset: %w", err)
	}
	var locked domain.UUID
	if err := tx.QueryRow(ctx, `
		SELECT id FROM creation_media_assets
		WHERE id = $1 AND (restricted_at IS NULL OR restriction_released_at IS NOT NULL)
		FOR UPDATE`, assetID).Scan(&locked); errors.Is(err, pgx.ErrNoRows) {
		return domain.PublicationDetail{}, domain.ErrPublicationNotFound
	} else if err != nil {
		return domain.PublicationDetail{}, fmt.Errorf("creation: lock publication asset: %w", err)
	}
	publication, err := scanPublication(tx.QueryRow(ctx, `SELECT `+publicationColumns+`
		FROM creation_team_publications p
		WHERE p.id = $1 AND p.withdrawn_at IS NULL AND p.restricted_at IS NULL
		FOR UPDATE OF p`, id))
	if err != nil {
		return domain.PublicationDetail{}, err
	}
	references, err := r.listPublicationReferences(ctx, tx, id)
	return domain.PublicationDetail{Publication: publication, References: references}, err
}

func loadSimilarOperation(ctx context.Context, source interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, actor domain.UUID, key string) (domain.SimilarCreation, domain.UUID, error) {
	var result domain.SimilarCreation
	var publicationID domain.UUID
	var specJSON []byte
	err := source.QueryRow(ctx, `
		SELECT operation.publication_id, session.id, session.owner_user_id, session.name,
		       session.created_at, session.updated_at, operation.specification
		FROM creation_publication_similar_operations operation
		JOIN creation_sessions session ON session.id = operation.session_id
		WHERE operation.owner_user_id = $1 AND operation.idempotency_key = $2`, actor, key).Scan(
		&publicationID, &result.Session.ID, &result.Session.OwnerID, &result.Session.Name,
		&result.Session.CreatedAt, &result.Session.UpdatedAt, &specJSON,
	)
	if err != nil {
		return domain.SimilarCreation{}, domain.UUID{}, err
	}
	if err := json.Unmarshal(specJSON, &result.Specification); err != nil {
		return domain.SimilarCreation{}, domain.UUID{}, err
	}
	for _, reference := range result.Specification.References {
		material, err := scanMaterial(source.QueryRow(ctx, `SELECT `+materialColumns+`
			FROM creation_reference_materials m WHERE m.id = $1`, reference.MaterialID))
		if err != nil {
			return domain.SimilarCreation{}, domain.UUID{}, err
		}
		result.Materials = append(result.Materials, material)
	}
	return result, publicationID, nil
}

func (r *TeamPublicationRepository) GetPublicationReference(ctx context.Context, publicationID, referenceID domain.UUID, admin bool) (domain.PublicationReference, error) {
	return scanPublicationReference(r.pool.QueryRow(ctx, `SELECT `+publicationReferenceColumns+`
		FROM creation_team_publication_references reference
		JOIN creation_team_publications publication ON publication.id = reference.publication_id
		JOIN creation_media_assets asset ON asset.id = publication.source_asset_id
		WHERE publication.id = $1 AND reference.id = $2
		  AND publication.withdrawn_at IS NULL
		  AND (($3 AND publication.direct_restricted_at IS NOT NULL
		          AND publication.direct_restriction_released_at IS NULL)
		    OR (publication.restricted_at IS NULL
		      AND (asset.restricted_at IS NULL OR asset.restriction_released_at IS NOT NULL)))`, publicationID, referenceID, admin))
}

func (r *TeamPublicationRepository) GetAdminAssetReference(ctx context.Context, assetID, referenceID domain.UUID) (domain.PublicationReference, error) {
	detail, err := r.GetAdminAsset(ctx, assetID)
	if err != nil {
		return domain.PublicationReference{}, err
	}
	for _, reference := range detail.References {
		if reference.ID == referenceID {
			return reference, nil
		}
	}
	return domain.PublicationReference{}, domain.ErrAssetNotFound
}

func (r *TeamPublicationRepository) RestrictAsset(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (domain.MediaAsset, bool, error) {
	var restrictedAt, releasedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT restricted_at, restriction_released_at
		FROM creation_media_assets
		WHERE id = $1 AND deleted_at IS NULL
		FOR UPDATE`, id).Scan(&restrictedAt, &releasedAt); errors.Is(err, pgx.ErrNoRows) {
		return domain.MediaAsset{}, false, domain.ErrAssetNotFound
	} else if err != nil {
		return domain.MediaAsset{}, false, fmt.Errorf("creation: lock asset for restriction: %w", err)
	}
	changed := restrictedAt == nil || releasedAt != nil
	if changed {
		var stamped time.Time
		if err := tx.QueryRow(ctx, `
			UPDATE creation_media_assets
			SET restricted_at = clock_timestamp(), restriction_released_at = NULL
			WHERE id = $1
			RETURNING restricted_at`, id).Scan(&stamped); err != nil {
			return domain.MediaAsset{}, false, fmt.Errorf("creation: restrict asset: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE creation_team_publications
			SET restricted_at = COALESCE(restricted_at, $2)
			WHERE source_asset_id = $1 AND withdrawn_at IS NULL AND restricted_at IS NULL`, id, stamped); err != nil {
			return domain.MediaAsset{}, false, fmt.Errorf("creation: terminate asset publications: %w", err)
		}
	}
	asset, err := scanAsset(tx.QueryRow(ctx, `SELECT `+assetColumns+assetFrom+`
		WHERE a.id = $1 AND a.deleted_at IS NULL`, id))
	if err != nil {
		return domain.MediaAsset{}, false, fmt.Errorf("creation: read restricted asset: %w", err)
	}
	return asset, changed, nil
}

func (r *TeamPublicationRepository) ReleaseAsset(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (domain.MediaAsset, bool, error) {
	var restrictedAt, releasedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT restricted_at, restriction_released_at
		FROM creation_media_assets
		WHERE id = $1 AND deleted_at IS NULL
		FOR UPDATE`, id).Scan(&restrictedAt, &releasedAt); errors.Is(err, pgx.ErrNoRows) {
		return domain.MediaAsset{}, false, domain.ErrAssetNotFound
	} else if err != nil {
		return domain.MediaAsset{}, false, fmt.Errorf("creation: lock asset for restriction release: %w", err)
	}
	changed := restrictedAt != nil && releasedAt == nil
	if changed {
		if _, err := tx.Exec(ctx, `
			UPDATE creation_media_assets
			SET restriction_released_at = clock_timestamp()
			WHERE id = $1`, id); err != nil {
			return domain.MediaAsset{}, false, fmt.Errorf("creation: release asset restriction: %w", err)
		}
	}
	asset, err := scanAsset(tx.QueryRow(ctx, `SELECT `+assetColumns+assetFrom+`
		WHERE a.id = $1 AND a.deleted_at IS NULL`, id))
	if err != nil {
		return domain.MediaAsset{}, false, fmt.Errorf("creation: read released asset: %w", err)
	}
	return asset, changed, nil
}

func (r *TeamPublicationRepository) RestrictPublication(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (domain.TeamPublication, bool, error) {
	assetActive, directAt, directReleasedAt, err := r.lockPublicationRestriction(ctx, tx, id)
	if err != nil {
		return domain.TeamPublication{}, false, err
	}
	changed := directAt == nil || directReleasedAt != nil
	if changed {
		if _, err := tx.Exec(ctx, `
			WITH stamp AS (SELECT clock_timestamp() AS at)
			UPDATE creation_team_publications publication
			SET restricted_at = COALESCE(publication.restricted_at, stamp.at),
			    direct_restricted_at = stamp.at,
			    direct_restriction_released_at = NULL
			FROM stamp
			WHERE publication.id = $1`, id); err != nil {
			return domain.TeamPublication{}, false, fmt.Errorf("creation: restrict team publication: %w", err)
		}
	}
	publication, err := r.getPublicationRestriction(ctx, tx, id, assetActive)
	return publication, changed, err
}

func (r *TeamPublicationRepository) ReleasePublication(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (domain.TeamPublication, bool, error) {
	assetActive, directAt, directReleasedAt, err := r.lockPublicationRestriction(ctx, tx, id)
	if err != nil {
		return domain.TeamPublication{}, false, err
	}
	changed := directAt != nil && directReleasedAt == nil
	if changed {
		if _, err := tx.Exec(ctx, `
			UPDATE creation_team_publications
			SET direct_restriction_released_at = clock_timestamp()
			WHERE id = $1`, id); err != nil {
			return domain.TeamPublication{}, false, fmt.Errorf("creation: release team publication restriction: %w", err)
		}
	}
	publication, err := r.getPublicationRestriction(ctx, tx, id, assetActive)
	return publication, changed, err
}

func (r *TeamPublicationRepository) lockPublicationRestriction(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (bool, *time.Time, *time.Time, error) {
	var assetID domain.UUID
	if err := tx.QueryRow(ctx, `
		SELECT source_asset_id FROM creation_team_publications
		WHERE id = $1 AND withdrawn_at IS NULL`, id).Scan(&assetID); errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil, domain.ErrPublicationNotFound
	} else if err != nil {
		return false, nil, nil, fmt.Errorf("creation: resolve publication restriction asset: %w", err)
	}
	var assetActive bool
	if err := tx.QueryRow(ctx, `
		SELECT restricted_at IS NOT NULL AND restriction_released_at IS NULL
		FROM creation_media_assets
		WHERE id = $1
		FOR UPDATE`, assetID).Scan(&assetActive); err != nil {
		return false, nil, nil, fmt.Errorf("creation: lock publication restriction asset: %w", err)
	}
	var directAt, directReleasedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT direct_restricted_at, direct_restriction_released_at
		FROM creation_team_publications
		WHERE id = $1 AND withdrawn_at IS NULL
		FOR UPDATE`, id).Scan(&directAt, &directReleasedAt); errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil, domain.ErrPublicationNotFound
	} else if err != nil {
		return false, nil, nil, fmt.Errorf("creation: lock publication restriction: %w", err)
	}
	return assetActive, directAt, directReleasedAt, nil
}

func (r *TeamPublicationRepository) getPublicationRestriction(ctx context.Context, tx domain.TxExecutor, id domain.UUID, assetActive bool) (domain.TeamPublication, error) {
	publication, err := scanPublication(tx.QueryRow(ctx, `SELECT `+publicationColumns+`
		FROM creation_team_publications p WHERE p.id = $1`, id))
	if err != nil {
		return domain.TeamPublication{}, err
	}
	if assetActive {
		publication.Restricted = true
		publication.RestrictionState = domain.RestrictionActive
	}
	return publication, nil
}

const publicationReferenceColumns = `reference.id, reference.publication_id, reference.position,
	reference.role, reference.kind, reference.file_name, reference.mime_type, reference.byte_size,
	reference.checksum_sha256, reference.blob_key, reference.width_px, reference.height_px,
	reference.pixel_count, reference.duration_ms, reference.claims_version`

func (r *TeamPublicationRepository) listPublicationReferences(ctx context.Context, source interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, id domain.UUID) ([]domain.PublicationReference, error) {
	rows, err := source.Query(ctx, `SELECT `+publicationReferenceColumns+`
		FROM creation_team_publication_references reference
		WHERE reference.publication_id = $1 ORDER BY reference.position`, id)
	if err != nil {
		return nil, fmt.Errorf("creation: list publication references: %w", err)
	}
	defer rows.Close()
	references := []domain.PublicationReference{}
	for rows.Next() {
		reference, err := scanPublicationReference(rows)
		if err != nil {
			return nil, err
		}
		references = append(references, reference)
	}
	return references, rows.Err()
}

func scanPublication(row rowScanner) (domain.TeamPublication, error) {
	var publication domain.TeamPublication
	var media string
	var specJSON []byte
	var restrictionState, directRestrictionState string
	err := row.Scan(&publication.ID, &publication.SourceAssetID, &publication.PublisherID,
		&publication.PublisherDisplayName, &media, &publication.Mime, &publication.BlobKey,
		&publication.ByteSize, &publication.Checksum, &publication.WidthPx, &publication.HeightPx,
		&publication.DurationMS, &specJSON, &publication.PublishedAt, &publication.Restricted,
		&restrictionState, &directRestrictionState)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TeamPublication{}, domain.ErrPublicationNotFound
	}
	if err != nil {
		return domain.TeamPublication{}, fmt.Errorf("creation: scan team publication: %w", err)
	}
	publication.MediaType = domain.MediaType(media)
	publication.RestrictionState = domain.RestrictionState(restrictionState)
	publication.DirectRestriction = domain.RestrictionState(directRestrictionState)
	if err := json.Unmarshal(specJSON, &publication.Specification); err != nil {
		return domain.TeamPublication{}, fmt.Errorf("creation: decode team publication specification: %w", err)
	}
	return publication, nil
}

func scanPublicationReference(row rowScanner) (domain.PublicationReference, error) {
	var reference domain.PublicationReference
	var role, kind string
	err := row.Scan(&reference.ID, &reference.PublicationID, &reference.Position, &role, &kind,
		&reference.FileName, &reference.MimeType, &reference.ByteSize, &reference.ChecksumSHA256,
		&reference.BlobKey, &reference.WidthPx, &reference.HeightPx, &reference.PixelCount,
		&reference.DurationMS, &reference.ClaimsVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.PublicationReference{}, domain.ErrPublicationNotFound
	}
	if err != nil {
		return domain.PublicationReference{}, fmt.Errorf("creation: scan publication reference: %w", err)
	}
	reference.Role, reference.Kind = domain.DraftRole(role), domain.Kind(kind)
	return reference, nil
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
