ALTER TABLE "profiles" RENAME COLUMN "payment_failed" TO "status";--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "status" SET DEFAULT 'active';