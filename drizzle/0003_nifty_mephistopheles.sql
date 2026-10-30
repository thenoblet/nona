CREATE UNIQUE INDEX "wishes_media_id_unique" ON "wishes" USING btree ("media_id") WHERE "wishes"."media_id" is not null;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_display_name_length" CHECK (char_length("guests"."display_name") <= 80);--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_celebration_check" CHECK ("media"."celebration" in ('ceremony', 'reception', 'thanks', 'more'));--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploader_name_length" CHECK (char_length("media"."uploader_name") <= 80);--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_original_filename_length" CHECK (char_length("media"."original_filename") <= 255);--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_removed_is_hidden" CHECK (not "media"."removed_by_uploader" or "media"."hidden_at" is not null);--> statement-breakpoint
-- Written by hand (drizzle-kit generates schema only). Uploads start closed: the couple open them
-- from the admin once the R2 bucket lock is in place. DO NOTHING keeps whatever they chose.
INSERT INTO "settings" ("key", "value") VALUES ('uploads_open', 'false'::jsonb) ON CONFLICT ("key") DO NOTHING;
