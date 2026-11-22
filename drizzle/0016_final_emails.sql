CREATE TABLE "final_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"rsvp_id" uuid,
	"email" text NOT NULL,
	"email_key" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_by" text NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "final_emails_kind" CHECK ("final_emails"."kind" in ('details', 'thanks')),
	CONSTRAINT "final_emails_status" CHECK ("final_emails"."status" in ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "final_whatsapp" (
	"kind" text NOT NULL,
	"phone_key" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"marked_by" text NOT NULL,
	CONSTRAINT "final_whatsapp_kind_phone_key_pk" PRIMARY KEY("kind","phone_key")
);
--> statement-breakpoint
ALTER TABLE "final_emails" ADD CONSTRAINT "final_emails_rsvp_id_rsvps_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "public"."rsvps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "final_emails_kind_email_unique" ON "final_emails" USING btree ("kind","email_key") WHERE not "final_emails"."test";--> statement-breakpoint
CREATE INDEX "final_emails_batch_idx" ON "final_emails" USING btree ("batch_id");