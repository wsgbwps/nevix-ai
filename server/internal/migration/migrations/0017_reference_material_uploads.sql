-- Reference Material Upload 是 creator-private 的持久单对象授权租约（issue #220）。
-- 对象从一开始就使用随机最终 key；只有 finalize 的短事务同时创建
-- immutable Reference Material 并把租约置为 finalized。#221 再扩展验证租约与终态。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.creation_reference_material_uploads (
  id                  uuid                     NOT NULL,
  owner_user_id       uuid                     NOT NULL,
  session_id          uuid                     NOT NULL,
  material_id         uuid                     NOT NULL,
  object_key          text                     NOT NULL,
  file_name           text                     NOT NULL,
  declared_kind       text                     NOT NULL,
  declared_mime_type  text                     NOT NULL,
  declared_byte_size  bigint                   NOT NULL,
  claims_version      integer                  NOT NULL,
  idempotency_key     text                     NOT NULL,
  payload_hash        bytea                    NOT NULL,
  connection_revision bigint                   NOT NULL,
  put_deadline        timestamp with time zone NOT NULL,
  finalize_deadline   timestamp with time zone NOT NULL,
  status              text                     NOT NULL DEFAULT 'pending',
  created_at          timestamp with time zone NOT NULL,
  finalized_at        timestamp with time zone,
  CONSTRAINT creation_reference_material_uploads_pkey PRIMARY KEY (id),
  CONSTRAINT creation_reference_material_uploads_owner_idempotency_key UNIQUE (owner_user_id, idempotency_key),
  CONSTRAINT creation_reference_material_uploads_material_id_key UNIQUE (material_id),
  CONSTRAINT creation_reference_material_uploads_object_key_key UNIQUE (object_key),
  CONSTRAINT creation_reference_material_uploads_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users (id),
  CONSTRAINT creation_reference_material_uploads_session_fk FOREIGN KEY (session_id) REFERENCES public.creation_sessions (id),
  CONSTRAINT creation_reference_material_uploads_file_name_check CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT creation_reference_material_uploads_declared_kind_check CHECK (declared_kind IN ('image', 'video', 'audio')),
  CONSTRAINT creation_reference_material_uploads_declared_mime_type_check CHECK (char_length(declared_mime_type) BETWEEN 1 AND 255),
  CONSTRAINT creation_reference_material_uploads_declared_byte_size_check CHECK (
    declared_byte_size > 0
    AND declared_byte_size <= CASE declared_kind
      WHEN 'image' THEN 10485760
      WHEN 'audio' THEN 52428800
      WHEN 'video' THEN 209715200
    END
  ),
  CONSTRAINT creation_reference_material_uploads_claims_version_check CHECK (claims_version >= 1),
  CONSTRAINT creation_reference_material_uploads_idempotency_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT creation_reference_material_uploads_payload_hash_check CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT creation_reference_material_uploads_deadlines_check CHECK (
    put_deadline = created_at + interval '60 minutes'
    AND finalize_deadline = created_at + interval '90 minutes'
  ),
  CONSTRAINT creation_reference_material_uploads_status_check CHECK (status IN ('pending', 'finalized')),
  CONSTRAINT creation_reference_material_uploads_finalized_at_check CHECK (
    (status = 'pending' AND finalized_at IS NULL)
    OR (status = 'finalized' AND finalized_at IS NOT NULL)
  )
);

-- owner/idempotency 唯一索引覆盖 owner FK；session FK 与历史 connection revision 查询分别建索引。
CREATE INDEX creation_reference_material_uploads_session_fk_idx
  ON public.creation_reference_material_uploads (session_id);

CREATE INDEX creation_reference_material_uploads_connection_revision_idx
  ON public.creation_reference_material_uploads (connection_revision);

GRANT SELECT, INSERT, UPDATE ON public.creation_reference_material_uploads TO identity_app;
