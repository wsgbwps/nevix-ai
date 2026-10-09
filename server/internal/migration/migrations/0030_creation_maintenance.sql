-- Creation owns the admission fence; no startup reset or lease expiry.
-- +goose Up
CREATE TABLE public.creation_maintenance (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    paused boolean NOT NULL DEFAULT false,
    owner_token uuid,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    CHECK (NOT paused OR owner_token IS NOT NULL)
);
INSERT INTO public.creation_maintenance (singleton) VALUES (true);
GRANT SELECT ON public.creation_maintenance TO identity_app;
GRANT UPDATE (paused, owner_token, revision) ON public.creation_maintenance TO identity_app;
