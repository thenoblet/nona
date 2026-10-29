CREATE TABLE "rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"name_key" text NOT NULL,
	"phone" text NOT NULL,
	"phone_key" text NOT NULL,
	"email" text,
	"email_key" text,
	"party_size" text NOT NULL,
	"answers" jsonb NOT NULL,
	"other_names" text,
	"song" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"email_status" text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_content" (
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_by" text NOT NULL,
	CONSTRAINT "site_content_key_version_pk" PRIMARY KEY("key","version")
);
--> statement-breakpoint
CREATE INDEX "rsvps_name_key_current_idx" ON "rsvps" USING btree ("name_key") WHERE "rsvps"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "rsvps_email_key_idx" ON "rsvps" USING btree ("email_key");