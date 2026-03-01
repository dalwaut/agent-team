-- Add follow_up_date column to team_items for client follow-up reminders
ALTER TABLE team_items ADD COLUMN IF NOT EXISTS follow_up_date date;
