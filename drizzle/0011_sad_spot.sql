CREATE INDEX "media_admin_idx" ON "media" USING btree ("uploaded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST,"uploader_name","celebration","kind") WHERE "media"."purpose" = 'album' and "media"."deleted_at" is null and "media"."uploaded_at" is not null;--> statement-breakpoint
CREATE INDEX "media_admin_counts_idx" ON "media" USING btree ("celebration","kind","status","conversion","highlight","removed_by_uploader","hidden_at") WHERE "media"."purpose" = 'album' and "media"."deleted_at" is null and "media"."uploaded_at" is not null;--> statement-breakpoint
CREATE INDEX "media_admin_celebration_idx" ON "media" USING btree ("celebration","uploaded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST,"kind") WHERE "media"."purpose" = 'album' and "media"."deleted_at" is null and "media"."uploaded_at" is not null;--> statement-breakpoint
CREATE INDEX "media_admin_state_idx" ON "media" USING btree ((case when "removed_by_uploader" then 'removed' when "hidden_at" is not null then 'hidden'
    when "status" = 'failed' or ("status" = 'ready' and "conversion" = 'failed') then 'failed'
    when "status" = 'uploaded' then 'processing'
    when "status" = 'ready' and "conversion" = 'converting' then 'converting'
    when "status" = 'ready' and "conversion" = 'queued' then 'queued' end),"uploaded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST,"uploader_name","celebration","kind","removed_by_uploader","hidden_at","status","conversion") WHERE "media"."purpose" = 'album' and "media"."deleted_at" is null and "media"."uploaded_at" is not null and (case when "media"."removed_by_uploader" then 'removed' when "media"."hidden_at" is not null then 'hidden'
    when "media"."status" = 'failed' or ("media"."status" = 'ready' and "media"."conversion" = 'failed') then 'failed'
    when "media"."status" = 'uploaded' then 'processing'
    when "media"."status" = 'ready' and "media"."conversion" = 'converting' then 'converting'
    when "media"."status" = 'ready' and "media"."conversion" = 'queued' then 'queued' end) is not null;--> statement-breakpoint
CREATE INDEX "media_admin_highlight_idx" ON "media" USING btree ("uploaded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST,"uploader_name","celebration","kind") WHERE "media"."purpose" = 'album' and "media"."deleted_at" is null and "media"."uploaded_at" is not null and "media"."highlight";--> statement-breakpoint
CREATE INDEX "wishes_admin_idx" ON "wishes" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "wishes"."deleted_at" is null;