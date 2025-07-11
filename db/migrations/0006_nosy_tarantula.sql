DO $$ BEGIN
 CREATE TYPE "public"."plan_duration" AS ENUM('monthly', 'yearly');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "plan_duration" "plan_duration";