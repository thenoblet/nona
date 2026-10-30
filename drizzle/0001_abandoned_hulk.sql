CREATE TABLE "rsvp_flag_dismissals" (
	"rsvp_id" uuid NOT NULL,
	"other_rsvp_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_by" text NOT NULL,
	CONSTRAINT "rsvp_flag_dismissals_rsvp_id_other_rsvp_id_pk" PRIMARY KEY("rsvp_id","other_rsvp_id"),
	CONSTRAINT "rsvp_flag_dismissals_smaller_id_first" CHECK ("rsvp_flag_dismissals"."rsvp_id" < "rsvp_flag_dismissals"."other_rsvp_id")
);
--> statement-breakpoint
ALTER TABLE "rsvp_flag_dismissals" ADD CONSTRAINT "rsvp_flag_dismissals_rsvp_id_rsvps_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "public"."rsvps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp_flag_dismissals" ADD CONSTRAINT "rsvp_flag_dismissals_other_rsvp_id_rsvps_id_fk" FOREIGN KEY ("other_rsvp_id") REFERENCES "public"."rsvps"("id") ON DELETE cascade ON UPDATE no action;