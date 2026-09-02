-- Capability Manifest v2 将图片模型从 Seedream 5.0 Lite 切换为 Pro。
-- 既有 image_capability 是旧模型目录检查的结果，不能证明同一凭据可见 Pro；
-- 对仍有效的 active Connection 只失效图片判定，保留凭据与视频判定，要求
-- Admin 通过既有 recheck 命令重新确认新模型。单例约束使本更新最多锁一行。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

UPDATE public.provider_connections
SET image_capability = 'checking',
    last_checked_at = NULL,
    last_check_outcome = NULL,
    updated_at = now()
WHERE terminated_at IS NULL
  AND credential_state = 'valid';
