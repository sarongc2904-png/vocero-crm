UPDATE "member" SET "role" = 'agent' WHERE "role" = 'member';--> statement-breakpoint
ALTER TABLE "member" ALTER COLUMN "role" SET DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_role_check" CHECK ("member"."role" in ('owner', 'admin', 'agent'));
