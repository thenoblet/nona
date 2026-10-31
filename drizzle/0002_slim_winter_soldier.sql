CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"link_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guests_link_token_unique" UNIQUE("link_token")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"kind" text NOT NULL,
	"guest_id" uuid,
	"uploader_name" text,
	"celebration" text NOT NULL,
	"celebration_set_by_admin" boolean DEFAULT false NOT NULL,
	"original_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"file_fingerprint" text,
	"multipart_upload_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"captured_at" timestamp with time zone,
	"listed_at" timestamp with time zone,
	"status" text DEFAULT 'uploading' NOT NULL,
	"failure_reason" text,
	"derived" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"width" integer,
	"height" integer,
	"duration_seconds" real,
	"thumbhash" text,
	"average_color" text,
	"video_codec" text,
	"browser_playable" boolean,
	"conversion" text DEFAULT 'none' NOT NULL,
	"conversion_requested_at" timestamp with time zone,
	"highlight" boolean DEFAULT false NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by" text,
	"removed_by_uploader" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_original_key_unique" UNIQUE("original_key"),
	CONSTRAINT "media_purpose_check" CHECK ("media"."purpose" in ('album', 'wish', 'site')),
	CONSTRAINT "media_kind_check" CHECK ("media"."kind" in ('photo', 'video', 'audio')),
	CONSTRAINT "media_status_check" CHECK ("media"."status" in ('uploading', 'uploaded', 'ready', 'failed')),
	CONSTRAINT "media_conversion_check" CHECK ("media"."conversion" in ('none', 'queued', 'converting', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"media_id" uuid NOT NULL,
	"alt" text NOT NULL,
	"focal_x" real DEFAULT 0.5 NOT NULL,
	"focal_y" real DEFAULT 0.5 NOT NULL,
	"card_key" text,
	"saved_by" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_images_focal_point_inside" CHECK ("site_images"."focal_x" between 0 and 1 and "site_images"."focal_y" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "upload_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_id" uuid,
	"media_id" uuid,
	"kind" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_events_kind_check" CHECK ("upload_events"."kind" in ('part-retry', 'failed', 'resumed', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "wishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_id" uuid,
	"signed_as" text NOT NULL,
	"kind" text NOT NULL,
	"message" text,
	"media_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "wishes_kind_check" CHECK ("wishes"."kind" in ('text', 'voice', 'video')),
	CONSTRAINT "wishes_text_has_message" CHECK ("wishes"."kind" <> 'text' or "wishes"."message" is not null),
	CONSTRAINT "wishes_recording_has_media" CHECK ("wishes"."kind" = 'text' or "wishes"."media_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_images" ADD CONSTRAINT "site_images_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_events" ADD CONSTRAINT "upload_events_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_events" ADD CONSTRAINT "upload_events_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_album_cursor_idx" ON "media" USING btree ("purpose","status","listed_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "media"."hidden_at" is null and "media"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_guest_id_idx" ON "media" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "media_resume_idx" ON "media" USING btree ("guest_id","size_bytes","file_fingerprint") WHERE "media"."status" = 'uploading';--> statement-breakpoint
CREATE INDEX "site_images_slot_newest_idx" ON "site_images" USING btree ("slot","saved_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "upload_events_created_at_idx" ON "upload_events" USING btree ("created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "upload_events_media_id_idx" ON "upload_events" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "wishes_wall_idx" ON "wishes" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "wishes"."hidden_at" is null and "wishes"."deleted_at" is null;