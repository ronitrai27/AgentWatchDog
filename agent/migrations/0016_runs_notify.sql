-- A run's own row changes too (status, end, outcome, merge) without a new event. Announce those
-- on the same channel, so a live view never misses how a run ended.
CREATE FUNCTION runs_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.pr_url IS DISTINCT FROM OLD.pr_url
     OR NEW.pr_merged_at IS DISTINCT FROM OLD.pr_merged_at THEN
    PERFORM pg_notify('run_events', json_build_object('run', NEW.run_id, 'seq', NEW.last_seq)::text);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runs_notify AFTER UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_notify();

-- A new run is announced too, so "is anything running?" updates at once.
CREATE FUNCTION runs_insert_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('run_events', json_build_object('run', NEW.run_id, 'seq', 0)::text);
  RETURN NEW;
END $$;

CREATE TRIGGER runs_insert_notify AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_insert_notify();
