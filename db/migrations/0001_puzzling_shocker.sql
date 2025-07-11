DO $$ BEGIN
 CREATE TYPE "public"."payment_provider" AS ENUM('stripe', 'whop');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "payment_provider" "payment_provider" DEFAULT 'stripe';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "whop_user_id" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "whop_membership_id" text;