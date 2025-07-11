ALTER TABLE "profiles" ALTER COLUMN "payment_provider" SET DEFAULT 'whop';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "email" text;