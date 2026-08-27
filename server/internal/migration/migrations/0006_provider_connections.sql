-- AI Provider Connection 的持久基座（AI Creation V1 切片 07，issue #157）。
-- 每个 Deployment Instance 最多一个 active Connection：terminated_at IS NULL 的部分
-- 唯一索引在数据库层固定单例，命令层并发写入由该约束收口。图片与视频共享该连接，
-- 没有按媒体的第二连接或 fallback（ADR-0016 / 规格 #150）。
-- 凭据保护是应用层 AEAD：主密钥在数据库外 secrets volume（目录 0700、文件 0600、
-- 原子创建），表中只存版本化 envelope（key ID、nonce、ciphertext）；AAD 绑定
-- Connection identity、Kapon 与凭据用途，密文不落明文。删除是终止事件：terminated_at
-- 置位并清空 envelope 列，保留非敏感历史 identity 供既有事实与 Audit Log 追溯，
-- 重新配置产生新的 Connection identity，不复活旧聚合。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.provider_connections (
  id                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  admin_state         text                     NOT NULL DEFAULT 'enabled',
  credential_state    text                     NOT NULL,
  image_capability    text                     NOT NULL,
  video_capability    text                     NOT NULL,
  envelope_version    integer,
  credential_key_id   text,
  credential_nonce    bytea,
  credential_ciphertext bytea,
  last_checked_at     timestamp with time zone,
  last_check_outcome  text,
  created_by_user_id  uuid                     NOT NULL,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  updated_at          timestamp with time zone NOT NULL DEFAULT now(),
  terminated_at       timestamp with time zone,
  CONSTRAINT provider_connections_pkey PRIMARY KEY (id),
  CONSTRAINT provider_connections_admin_state_check CHECK (admin_state = ANY (ARRAY['enabled'::text, 'paused'::text])),
  CONSTRAINT provider_connections_credential_state_check CHECK (credential_state = ANY (ARRAY['checking'::text, 'valid'::text, 'invalid'::text, 'credential_unavailable'::text])),
  CONSTRAINT provider_connections_media_capability_check CHECK (
    image_capability = ANY (ARRAY['checking'::text, 'available'::text, 'unavailable'::text])
    AND video_capability = ANY (ARRAY['checking'::text, 'available'::text, 'unavailable'::text])
  ),
  CONSTRAINT provider_connections_last_check_outcome_check CHECK (last_check_outcome IS NULL OR last_check_outcome = ANY (ARRAY['completed'::text, 'temporarily_unavailable'::text])),
  -- active Connection 必须携带完整 envelope；终止行必须整体清除 envelope——
  -- 删除清除密文但保留非敏感 identity 正是该 CHECK 的职责边界。
  CONSTRAINT provider_connections_envelope_presence_check CHECK (
    (terminated_at IS NULL AND envelope_version IS NOT NULL AND credential_key_id IS NOT NULL AND credential_nonce IS NOT NULL AND credential_ciphertext IS NOT NULL)
    OR (terminated_at IS NOT NULL AND envelope_version IS NULL AND credential_key_id IS NULL AND credential_nonce IS NULL AND credential_ciphertext IS NULL)
  ),
  CONSTRAINT provider_connections_created_by_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users (id)
);

-- 实例级单例：active（未终止）行至多一行。命令并发下第二个 INSERT 撞本索引回滚。
CREATE UNIQUE INDEX provider_connections_singleton_idx
  ON public.provider_connections ((1))
  WHERE terminated_at IS NULL;

-- 规格：每个 Foreign Key 都有匹配索引。
CREATE INDEX provider_connections_created_by_fk_idx
  ON public.provider_connections (created_by_user_id);

-- 终止是 UPDATE，不是行删除：identity_app 不获得 DELETE 权限。
GRANT SELECT, INSERT, UPDATE ON public.provider_connections TO identity_app;
