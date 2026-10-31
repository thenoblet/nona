DROP INDEX "media_withdrawal_idx";--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "withdrawing_keys" text[];--> statement-breakpoint
CREATE INDEX "media_withdrawal_idx" ON "media" USING btree ("id") WHERE (("media"."hidden_at" is not null or "media"."deleted_at" is not null) and "media"."derived" <> '{}'::jsonb) or "media"."withdrawing_keys" is not null;