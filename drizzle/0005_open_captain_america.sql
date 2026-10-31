ALTER TABLE "media" ADD COLUMN "conversion_job_id" uuid;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "conversion_failure_reason" text;--> statement-breakpoint
CREATE INDEX "media_conversion_converting_idx" ON "media" USING btree ("listed_at") WHERE "media"."status" = 'ready' and "media"."conversion" = 'converting';