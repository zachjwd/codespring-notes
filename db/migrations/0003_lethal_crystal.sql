ALTER TABLE "profiles" ADD COLUMN "billing_cycle_start" timestamp;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "billing_cycle_end" timestamp;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "usage_credits" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "used_credits" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "payment_failed" boolean DEFAULT false;