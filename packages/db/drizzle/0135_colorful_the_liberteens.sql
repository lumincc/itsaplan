CREATE TABLE "agent_transcript_segment" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer,
	"message_id" integer,
	"harness" text NOT NULL,
	"seq" integer NOT NULL,
	"line_count" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_transcript_scope_check" CHECK (num_nonnulls("agent_transcript_segment"."run_id", "agent_transcript_segment"."message_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "cli_session_id" text;--> statement-breakpoint
ALTER TABLE "agent_transcript_segment" ADD CONSTRAINT "agent_transcript_segment_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_segment" ADD CONSTRAINT "agent_transcript_segment_message_id_agent_chat_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_chat_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_run_seq_uq" ON "agent_transcript_segment" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_message_seq_uq" ON "agent_transcript_segment" USING btree ("message_id","seq");