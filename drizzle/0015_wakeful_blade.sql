CREATE TABLE "admin_viewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	CONSTRAINT "admin_viewers_email_lowercase" CHECK ("admin_viewers"."email" = lower(btrim("admin_viewers"."email"))),
	CONSTRAINT "admin_viewers_removed_together" CHECK (("admin_viewers"."removed_at" is null) = ("admin_viewers"."removed_by" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_viewers_current_email_unique" ON "admin_viewers" USING btree ("email") WHERE "admin_viewers"."removed_at" is null;