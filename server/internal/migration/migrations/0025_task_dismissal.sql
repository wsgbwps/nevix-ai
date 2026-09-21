-- 任务隐藏：一个终态 Generation Task 可以不再出现在创作台，而其结果 Media Asset
-- 用既有的 deleted_at 逻辑删除机制一并移除。
-- dismissed_at 的写入权限本就由 0008 给 identity_app 的表级 UPDATE 覆盖（表级授权
-- 含此后新增的列），下面的列级授权是显式的冗余，只为让本列的权限在此处一眼可读。
-- 生成侧仍无表级 DELETE（ADR-0015 最小权限）。

-- +goose Up

ALTER TABLE public.creation_generation_tasks
  ADD COLUMN dismissed_at timestamp with time zone;

GRANT UPDATE (dismissed_at) ON public.creation_generation_tasks TO identity_app;
